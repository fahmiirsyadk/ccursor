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

import { conversation, modelId } from "./request.js";
import { systemPrompt } from "./prompt.js";
import { resolveModel, stream } from "./provider.js";
import { EXEC_CASES, TOOL_TYPES, findTool, providerTools, renderResult, toToolResult } from "./tools.js";
import { execServerMessage, toolCallCompleted, toolCallStarted, waitForExec } from "./exec.js";
import { detail, info } from "../ui.js";
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
    const reply = await waitForExec(requestId, execId);
    if (!reply) return null;

    const outcome = execOutcome(reply);
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
async function* runTool({ root, requestId, allocateExecId, tool, input, callId, modelCallId }) {
  const toolType = TOOL_TYPES[tool.name];
  const args = tool.startedArgs ? tool.startedArgs(input, callId) : tool.buildArgs(input, callId);

  yield toolCallStarted(root, { callId, toolType, args, modelCallId });

  const execArgs = tool.buildArgs(input, callId);
  const result =
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
export async function* runTurn({ root, request, providers, requestId, queued, signal }) {
  const requested = modelId(request);
  const resolved = resolveModel(providers, requested);

  if (!resolved) {
    yield textDelta(
      root,
      `No provider is configured for \`${requested || "the requested model"}\`. ` +
        "Add it to `~/.ccursor/providers.json` and reopen the model picker.",
    );
    yield turnEnded(root, {});
    return;
  }

  const { provider, apiModel } = resolved;

  const messages = [
    { role: "system", content: systemPrompt(request) },
    ...conversation(request, queued),
  ];
  const tools = providerTools();

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

    const events = stream({ provider, apiModel, messages, tools, signal });

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

    if (thinkingStarted > 0) yield thinkingCompleted(root, Date.now() - thinkingStarted);

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
      if (!tool) {
        messages.push({
          role: "tool",
          toolCallId: call.id,
          toolName: call.name,
          content: `Error: unknown tool "${call.name}".`,
        });
        continue;
      }

      detail(`tool ${call.name} ${String(JSON.stringify(parseArguments(call.arguments))).slice(0, 120)}`);
      usedTools.push(call.name);

      const outcome = yield* runTool({
        root,
        requestId,
        allocateExecId,
        tool,
        input: parseArguments(call.arguments),
        callId: call.id,
        modelCallId: `${requestId}-${round}-${call.id.slice(-4)}`,
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
