/**
 * Response encoding.
 *
 * Everything Cursor receives on `RunSSE` is an `agent.v1.AgentServerMessage`. Most
 * of what it needs are interaction updates — one small message per streamed change.
 * The builders here keep the field names in one place so a schema rename breaks one
 * file instead of the whole server.
 */

import { lookupType } from "../proto/schema.js";

const SERVER_MESSAGE = "agent.v1.AgentServerMessage";

/** Encode any AgentServerMessage from a plain object. */
export function encodeMessage(root, value) {
  const Type = lookupType(root, SERVER_MESSAGE);
  return Buffer.from(Type.encode(Type.fromObject(value)).finish());
}

/** Encode one interaction update into an AgentServerMessage. */
export function encode(root, update) {
  return encodeMessage(root, { interaction_update: update });
}

/** Liveness. Cursor expects one every few seconds while a turn is quiet. */
export function heartbeat(root) {
  return encode(root, { heartbeat: {} });
}

/** A piece of the answer. */
export function textDelta(root, text) {
  return encode(root, { text_delta: { text } });
}

/** A piece of the model's reasoning, shown as a collapsible block. */
export function thinkingDelta(root, text) {
  return encode(root, { thinking_delta: { text, thinking_style: 1 } });
}

/** Reasoning finished; Cursor collapses the block and shows the duration. */
export function thinkingCompleted(root, durationMs) {
  return encode(root, { thinking_completed: { thinking_duration_ms: Math.max(0, Math.round(durationMs)) } });
}

/** Progress counter for the context bar. */
export function tokenDelta(root, tokens) {
  return encode(root, { token_delta: { tokens } });
}

/** End of one model round. */
export function stepCompleted(root, stepId, durationMs) {
  return encode(root, {
    step_completed: { step_id: stepId, step_duration_ms: Math.max(0, Math.round(durationMs)) },
  });
}

/** End of the whole turn, carrying what it cost. */
export function turnEnded(root, usage) {
  return encode(root, {
    turn_ended: {
      input_tokens: usage?.inputTokens ?? 0,
      output_tokens: usage?.outputTokens ?? 0,
      cache_read_tokens: usage?.cacheReadTokens ?? 0,
      cache_write_tokens: usage?.cacheWriteTokens ?? 0,
      reasoning_tokens: usage?.reasoningTokens ?? 0,
    },
  });
}
