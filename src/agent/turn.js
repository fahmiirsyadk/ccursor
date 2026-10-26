/**
 * One agent turn.
 *
 * Consumes a decoded run request and yields encoded `AgentServerMessage` frames in
 * the order Cursor expects: heartbeat, thinking, text, tool calls, token counters,
 * then the step and turn boundaries.
 *
 * Agent mode is a loop, not one request. The model asks for a tool, the editor runs
 * it, the result goes back to the model, and the loop repeats until the model stops
 * asking. The loop lives here because the conversation state lives here.
 */

import { conversation, imagesFrom, modelId, subagentType, workspacePaths } from "./request.js";
import {
  annotate,
  corruptNote,
  droppedNotice,
  imagePolicy,
  partition,
  stripImages,
  unseenNote,
} from "./vision.js";
import { readAll as ocrText } from "./ocr.js";
import { withImageFallback } from "./provider.js";
import { withSystemPrompt } from "./prompt.js";
import { basePrompt } from "../prompt/base.js";
import { appRootFromWorkbench } from "../prompt/bundle.js";
import { userInfo } from "../prompt/user-info.js";
import { resolveModel, stream } from "./provider.js";
import { EXEC_CASES, TOOL_TYPES, findTool, providerTools, renderResult, toToolResult } from "./tools.js";
import { execServerMessage, nextExecReply, toolCallCompleted, toolCallStarted } from "./exec.js";
import { detail, info, warn } from "../ui.js";
import {
  heartbeat,
  stepCompleted,
  textDelta,
  thinkingCompleted,
  thinkingDelta,
  tokenDelta,
  turnEnded,
} from "./updates.js";

/** How often to prove the stream is alive while the model is quiet. */
const HEARTBEAT_MS = 4000;

/** How often to nudge the context bar. */
const TOKEN_EVERY_CHARS = 200;

/** A runaway loop is a bug, not a long task. */
const MAX_ROUNDS = 40;

/** Interleave heartbeats into an event stream that may go quiet. */
async function* withHeartbeat(events, root) {
  const iterator = events[Symbol.asyncIterator]();
  let pending = null;

  for (;;) {
    pending ??= iterator.next();

    let timer;
    const beat = new Promise((resolve) => {
      timer = setTimeout(() => resolve("beat"), HEARTBEAT_MS);
      timer.unref?.();
    });

    const result = await Promise.race([pending, beat]);
    clearTimeout(timer);

    if (result === "beat") {
      yield { type: "heartbeat", frame: heartbeat(root) };
      continue;
    }

    pending = null;
    if (result.done) return;
    yield result.value;
  }
}

/**
 * Copy a decoded message into plain objects.
 *
 * protobufjs decodes into class instances whose oneof accessors live on the
 * prototype. Re-encoding such an instance as a *different* message type silently
 * drops oneof fields, because the encoder checks for own properties. Converting
 * first keeps every field that was actually set.
 */
function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = plain(inner);
    return out;
  }
  return value;
}

/** Which result variant the editor sent back. */
function execOutcome(exec) {
  for (const [key, value] of Object.entries(exec ?? {})) {
    if (!key.endsWith("_result") && !key.endsWith("_stream")) continue;
    if (value === undefined || value === null) continue;
    return { case: key, value: plain(value) };
  }
  return null;
}

/**
 * Send one exec request and wait for its result.
 *
 * Streaming variants arrive first; the final `*_result` is the one to keep.
 */
async function* execOnce({ root, requestId, execId, execCase, execName, value }) {
  yield execServerMessage(root, { id: execId, execId: execName, caseName: execCase, value });

  for (;;) {
    const step = await nextExecReply(requestId, execId, HEARTBEAT_MS);

    if (step.kind === "closed") return null;

    if (step.kind === "idle") {
      // Keep the stream alive while the editor works. Without this, a Shell command
      // that takes longer than Cursor's 30-second stall window kills the whole turn
      // with "Connection stalled repeatedly".
      yield heartbeat(root);
      continue;
    }

    const outcome = execOutcome(step.value);
    if (!outcome) continue;
    if (outcome.case.endsWith("_stream")) continue;
    return outcome.value;
  }
}

/** Map a read failure onto the edit result vocabulary. */
function readFailureToEdit(result) {
  if (!result) return { error: { message: "the editor did not answer the read" } };
  if (result.file_not_found) return { file_not_found: result.file_not_found };
  if (result.permission_denied) return { read_permission_denied: result.permission_denied };
  if (result.rejected) return { rejected: result.rejected };
  if (result.invalid_file) return { error: { message: "the file is not text" } };
  return result;
}

/** Line counts for the edit summary, without a full diff algorithm. */
function lineDelta(before, after) {
  const count = (text) => {
    const map = new Map();
    for (const line of text.split("\n")) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };

  const left = count(before);
  const right = count(after);
  let added = 0;
  let removed = 0;

  for (const [line, n] of right) added += Math.max(0, n - (left.get(line) ?? 0));
  for (const [line, n] of left) removed += Math.max(0, n - (right.get(line) ?? 0));
  return { added, removed };
}

/**
 * Edit is read-then-write.
 *
 * The editor has no "replace" exec, so the new content is computed here and written
 * in full. That also means an ambiguous old_string is caught before anything is
 * written, which is the behaviour the tool description promises.
 */
async function* editViaReadWrite({ root, requestId, allocateExecId, args, callId }) {
  const path = args.path;
  const oldString = args.old_string;
  const newString = args.new_string;

  if (oldString.length === 0) {
    return { error: { message: "Edit needs old_string. Use Write to create a file." } };
  }

  const read = yield* execOnce({
    root,
    requestId,
    execId: allocateExecId(),
    execCase: "readArgs",
    execName: `${callId}-read`,
    value: { path, tool_call_id: callId },
  });

  if (!read || !read.success) return readFailureToEdit(read);

  const before = read.success.content ?? "";
  const occurrences = before.split(oldString).length - 1;

  if (occurrences === 0) {
    return { error: { message: `old_string was not found in ${path}. Read the file again.` } };
  }
  if (occurrences > 1 && !args.replace_all) {
    return {
      error: {
        message: `old_string appears ${occurrences} times in ${path}. Pass replace_all, or include more context so it is unique.`,
      },
    };
  }

  const at = before.indexOf(oldString);
  const after = args.replace_all
    ? before.split(oldString).join(newString)
    : before.slice(0, at) + newString + before.slice(at + oldString.length);

  const write = yield* execOnce({
    root,
    requestId,
    execId: allocateExecId(),
    execCase: "writeArgs",
    execName: `${callId}-write`,
    value: {
      path,
      file_text: after,
      stream_content: after,
      encoding_hint: "utf8",
      tool_call_id: callId,
    },
  });

  if (!write) return { error: { message: "the editor did not answer the write" } };
  if (!write.success) return write;

  const { added, removed } = lineDelta(before, after);
  return {
    success: {
      path,
      lines_added: added,
      lines_removed: removed,
      diff_string: "",
      before_full_file_content: before,
      after_full_file_content: after,
      message: "",
    },
  };
}

/**
 * Run one tool: ask the editor, wait for the answer.
 *
 * Yields the frames the UI needs and returns what the model should be told.
 */
async function* runTool({ root, requestId, allocateExecId, tool, input, callId, modelCallId, context }) {
  const toolType = TOOL_TYPES[tool.name];
  const args = tool.startedArgs ? tool.startedArgs(input, callId) : tool.buildArgs(input, callId);

  yield toolCallStarted(root, { callId, toolType, args, modelCallId });

  const execArgs = tool.buildArgs(input, callId, context);
  let result =
    tool.name === "Edit"
      ? yield* editViaReadWrite({ root, requestId, allocateExecId, args: execArgs, callId })
      : yield* execOnce({
          root,
          requestId,
          execId: allocateExecId(),
          execCase: EXEC_CASES[tool.name],
          execName: `${callId}-${tool.name.toLowerCase()}`,
          value: execArgs,
        });

  // Some calls are rejected in a way the model cannot fix from the error text alone,
  // and the correction is known here. A tool declares it; Glob uses it because
  // ripgrep refuses a search with no pattern.
  const corrected = result && tool.retry ? tool.retry(execArgs, result) : null;
  if (corrected) {
    result = yield* execOnce({
      root,
      requestId,
      execId: allocateExecId(),
      execCase: EXEC_CASES[tool.name],
      execName: `${callId}-${tool.name.toLowerCase()}-retry`,
      value: corrected,
    });
  }

  if (!result) {
    return { text: "Error: the editor did not answer this tool call.", result: null };
  }

  const text = renderResult(tool.name, result);
  const uiResult = tool.name === "Edit" ? result : toToolResult(tool.name, result);
  yield toolCallCompleted(root, { callId, toolType, args, result: uiResult, modelCallId });

  return { text, result };
}

/**
 * Run one turn.
 *
 * @param {object} options
 * @param {import("protobufjs").Root} options.root loaded schema
 * @param {object} options.request decoded AgentRunRequest
 * @param {Array} options.providers entries from providers.json
 * @param {string} options.requestId session id, for tool replies
 * @param {AbortSignal} [options.signal]
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* runTurn({ root, request, providers, requestId, queued, signal, workbench }) {
  const requested = modelId(request);
  const resolved = resolveModel(providers, requested);

  if (!resolved) {
    yield textDelta(
      root,
      `No provider is configured for \`${requested || "the requested model"}\`. ` +
        "Add it to `providers.json` in the state directory and reopen the model picker.",
    );
    yield turnEnded(root, {});
    return;
  }

  const { provider, apiModel } = resolved;

  // A subagent is a run in its own right, with its own RunSSE. It must not be given
  // the Task tool: it would re-delegate the same work one level deeper.
  const subagent = subagentType(request);
  const roots = workspacePaths(request);
  if (roots.length > 0) detail(`workspace: ${roots.join(", ")}`);
  else warn("no workspace path in the request; file tools will not default to it");

  let turns = conversation(request, queued);
  const all = imagesFrom(request);

  // A corrupt payload is rejected by the provider with an error that says nothing
  // useful, and the whole turn goes with it. Catching it here costs one check.
  const { usable: images, corrupt } = partition(all);
  if (corrupt.length > 0) {
    warn(`${corrupt.length} attached image(s) are not valid images; not sent`);
    turns = stripImages(turns);
    if (images.length === 0) annotate(turns, corruptNote(corrupt));
  }

  const policy = imagePolicy(resolved.model, images);
  if (images.length > 0) {
    detail(
      `${images.length} image(s) ${policy === "skip" ? "withheld" : "sent"} ` +
        `(${images.map((image) => image.mimeType).join(", ")})`,
    );
  }

  // Dropping an image silently makes the assistant answer "you attached nothing",
  // which is both wrong and confusing. The model is told what arrived either way.
  if (policy === "skip" && images.length > 0) {
    detail(`${images.length} image(s) cannot be sent to ${resolved.model.id}`);

    // The text inside a screenshot is often the whole point, and it can be read
    // locally. That turns "I cannot see your image" into a real answer.
    const ocr = await ocrText(images);
    if (ocr.length > 0) detail(`OCR read ${ocr.length} image(s)`);

    turns = stripImages(turns);
    annotate(turns, unseenNote(images, ocr));
    yield textDelta(root, droppedNotice(images, resolved.model.id, ocr.length));
  }

  // Cursor's own system message: its user_info block (workspace, OS, shell, date),
  // then its agent prompt, then whatever instructions the request carries. Nothing
  // here is written by this project.
  const base = basePrompt();
  let environment = "";
  if (workbench) {
    try {
      environment = userInfo(request, { appRoot: appRootFromWorkbench(workbench) });
    } catch (error) {
      // A prompt block is not worth failing a turn over.
      warn(`user_info not built: ${error.message}`);
    }
  }

  let messages = withSystemPrompt(request, turns, { base, userInfo: environment });
  const system = messages[0]?.role === "system" ? messages[0].content : "";
  detail(
    system.length === 0
      ? "system message: none"
      : `system message: ${system.length} chars ` +
        `(user_info ${environment.length}, Cursor prompt ${base.length}, ` +
        `request ${system.length - environment.length - base.length})`,
  );
  const tools = providerTools({ subagent });
  if (subagent) {
    info(`subagent turn: ${subagent} (${tools.length} tools: ${tools.map((t) => t.name).join(", ")})`);
  }

  yield heartbeat(root);

  const started = Date.now();
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let execCounter = 0;
  const allocateExecId = () => {
    execCounter += 1;
    return execCounter;
  };
  let stepId = 1;
  let textTotal = 0;
  const usedTools = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (signal?.aborted) return;

    const roundStarted = Date.now();
    let thinkingStarted = 0;
    let textChars = 0;
    let sinceToken = 0;
    let stopReason = "end_turn";

    /** Tool calls are only usable once their arguments are complete. */
    const calls = [];
    const pending = new Map();

    const events = withImageFallback({
      provider,
      apiModel,
      messages,
      tools,
      signal,
      images,
      policy,
    });

    // A provider failure is reported in the conversation rather than as a bare
    // error toast: "out of capacity" is something the user can act on.
    let providerError = null;

    try {
      for await (const event of withHeartbeat(events, root)) {
        if (event.type === "heartbeat") {
          yield event.frame;
          continue;
        }

        switch (event.type) {
          case "thinking_delta":
            if (thinkingStarted === 0) thinkingStarted = Date.now();
            yield thinkingDelta(root, event.text);
            break;

          case "thinking_done":
            if (thinkingStarted > 0) {
              yield thinkingCompleted(root, Date.now() - thinkingStarted);
              thinkingStarted = 0;
            }
            break;

          case "text_delta":
            if (thinkingStarted > 0) {
              yield thinkingCompleted(root, Date.now() - thinkingStarted);
              thinkingStarted = 0;
            }
            textChars += event.text.length;
            textTotal += event.text.length;
            sinceToken += event.text.length;
            yield textDelta(root, event.text);
            if (sinceToken >= TOKEN_EVERY_CHARS) {
              sinceToken = 0;
              yield tokenDelta(root, Math.round(textChars / 4));
            }
            break;

          case "tool_use_start":
            pending.set(event.id, { id: event.id, name: event.name, arguments: "" });
            break;

          case "tool_use_delta": {
            const entry = pending.get(event.id);
            if (entry) entry.arguments += event.input;
            break;
          }

          case "tool_use_done": {
            const entry = pending.get(event.id) ?? {
              id: event.id,
              name: event.name,
              arguments: event.arguments ?? "",
            };
            entry.arguments = event.arguments ?? entry.arguments;
            pending.delete(event.id);
            calls.push(entry);
            break;
          }

          case "done":
            Object.assign(usage, event.usage ?? {});
            stopReason = event.stopReason ?? stopReason;
            break;

          default:
            break;
        }
      }
    } catch (error) {
      // The provider refused or failed. Say so in the conversation: a bare error
      // toast loses the reason, and "out of capacity" is something to act on.
      providerError = error;
    }

    if (providerError) {
      warn(`provider failed: ${providerError.message}`);
      yield textDelta(root, `The provider could not complete this turn.\n\n\`${providerError.message}\``);
      yield turnEnded(root, usage);
      return;
    }

    if (thinkingStarted > 0) yield thinkingCompleted(root, Date.now() - thinkingStarted);

    if (events.droppedImages) {
      // The provider refused the image mid-flight; the round was retried without it.
      detail(`provider rejected images; retried without them`);
      yield textDelta(root, droppedNotice(images, resolved.model.id));
      messages = annotate(messages, unseenNote(images));
    }

    yield stepCompleted(root, stepId, Date.now() - roundStarted);

    if (stopReason !== "tool_use" || calls.length === 0) {
      info(
        `turn done: ${usedTools.length > 0 ? usedTools.join(", ") : "no tools"}, ` +
          `${textTotal} chars, ${usage.inputTokens}in/${usage.outputTokens}out`,
      );
      yield turnEnded(root, usage);
      return;
    }

    // The assistant turn that asked for tools has to be in the history, or the
    // provider cannot match the results to the calls on the next round.
    messages.push({
      role: "assistant",
      content: calls.map((call) => ({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: parseArguments(call.arguments),
      })),
    });

    for (const call of calls) {
      const tool = findTool(call.name);

      if (subagent && tool?.name === "Task") {
        // Belt and braces: the tool is not offered, but a model can still emit it.
        warn(`subagent ${subagent} tried to delegate again; refused`);
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content:
            "Error: you are already a subagent. Do the work yourself with the tools " +
            "you have; do not delegate again.",
        });
        continue;
      }

      if (!tool) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: `Error: unknown tool "${call.name}".`,
        });
        continue;
      }

      detail(
        `tool ${call.name} [${subagent || "main"}] ` +
          String(JSON.stringify(parseArguments(call.arguments))).slice(0, 120),
      );
      usedTools.push(call.name);

      const outcome = yield* runTool({
        root,
        requestId,
        allocateExecId,
        tool,
        input: parseArguments(call.arguments),
        callId: call.id,
        modelCallId: `${requestId}-${round}-${call.id.slice(-4)}`,
        context: {
          modelId: apiModel,
          conversationId: request?.conversation_id ?? "",
          workspacePaths: roots,
        },
      });

      messages.push({
        role: "tool",
        toolCallId: call.id,
        toolName: call.name,
        content: outcome.text,
      });
    }

    stepId += 1;
  }

  info(
    `turn done: ${usedTools.length > 0 ? usedTools.join(", ") : "no tools"}, ` +
      `${textTotal} chars, ${usage.inputTokens}in/${usage.outputTokens}out`,
  );
  yield turnEnded(root, usage);
}

/** Model arguments are JSON, but a truncated stream is not. */
function parseArguments(raw) {
  if (!raw || typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
