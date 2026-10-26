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
import { EXEC_CASES, TOOL_TYPES, findTool, providerTools, renderResult } from "./tools.js";
import { execServerMessage, toolCallCompleted, toolCallStarted, waitForExec } from "./exec.js";
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

/** Which result variant the editor sent back. */
function execOutcome(exec) {
  for (const [key, value] of Object.entries(exec ?? {})) {
    if (!key.endsWith("_result") && !key.endsWith("_stream")) continue;
    if (value === undefined || value === null) continue;
    return { case: key, value };
  }
  return null;
}

/**
 * Run one tool: ask the editor, wait for the answer.
 *
 * Yields the frames the UI needs and returns what the model should be told.
 */
async function* runTool({ root, requestId, execId, tool, input, callId, modelCallId }) {
  const toolType = TOOL_TYPES[tool.name];
  const execCase = EXEC_CASES[tool.name];
  const args = tool.buildArgs(input, callId);

  yield toolCallStarted(root, { callId, toolType, args, modelCallId });
  yield execServerMessage(root, {
    id: execId,
    execId: `${callId}-${tool.name.toLowerCase()}`,
    caseName: execCase,
    value: args,
  });

  let result = null;
  for (;;) {
    const reply = await waitForExec(requestId, execId);
    if (!reply) return { text: "Error: the editor did not answer this tool call.", result: null };

    const outcome = execOutcome(reply);
    if (!outcome) continue;
    // Streaming variants arrive first; the final `*_result` is the one to keep.
    if (outcome.case.endsWith("_stream")) continue;
    result = outcome.value;
    break;
  }

  const text = renderResult(tool.name, result);
  yield toolCallCompleted(root, { callId, toolType, args, result, modelCallId });

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
  let execId = 0;
  let stepId = 1;

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

      execId += 1;
      const outcome = yield* runTool({
        root,
        requestId,
        execId,
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
