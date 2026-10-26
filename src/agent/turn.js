/**
 * One agent turn.
 *
 * Consumes a decoded run request and yields encoded `AgentServerMessage` frames in
 * the order Cursor expects: heartbeat, thinking, text, token counters, then the
 * step and turn boundaries. The generator is driven by the SSE response, so the
 * client sees text as the model produces it rather than after the fact.
 */

import { conversation, modelId } from "./request.js";
import { systemPrompt } from "./prompt.js";
import { resolveModel, stream } from "./provider.js";
import {
  encode,
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
 * Run one turn.
 *
 * @param {object} options
 * @param {import("protobufjs").Root} options.root loaded schema
 * @param {object} options.request decoded AgentRunRequest
 * @param {Array} options.providers entries from providers.json
 * @param {AbortSignal} [options.signal]
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* runTurn({ root, request, providers, signal }) {
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

  const { provider, model, apiModel } = resolved;

  const messages = [
    { role: "system", content: systemPrompt(request) },
    ...conversation(request),
  ];

  yield heartbeat(root);

  const started = Date.now();
  let thinkingStarted = 0;
  let thinkingChars = 0;
  let textChars = 0;
  let sinceToken = 0;
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let stopReason = "end_turn";

  const events = stream({
    provider,
    apiModel,
    messages,
    signal,
  });

  for await (const event of withHeartbeat(events, root)) {
    if (event.type === "heartbeat") {
      yield event.frame;
      continue;
    }

    switch (event.type) {
      case "thinking_delta":
        if (thinkingStarted === 0) thinkingStarted = Date.now();
        thinkingChars += event.text.length;
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

      case "done":
        usage = event.usage ?? usage;
        stopReason = event.stopReason ?? stopReason;
        break;

      default:
        // Tool calls arrive here once the agent loop handles them.
        break;
    }
  }

  if (thinkingStarted > 0) yield thinkingCompleted(root, Date.now() - thinkingStarted);

  yield stepCompleted(root, 1, Date.now() - started);

  // A turn that stopped to call a tool does not end; the caller continues it.
  if (stopReason !== "tool_use") {
    yield turnEnded(root, usage);
  }
}

export { encode };
