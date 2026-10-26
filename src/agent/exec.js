/**
 * Tool execution.
 *
 * The server never touches the filesystem. It asks the editor to run the tool and
 * waits for the answer on the same stream, which is what keeps permission prompts,
 * diffs and terminal integration working exactly as Cursor intends:
 *
 *   server → toolCallStarted        the UI shows the call
 *   server → execServerMessage      the editor runs it
 *   client → execClientMessage      the result comes back
 *   server → toolCallCompleted      the UI shows the outcome
 *
 * Every exec request carries an id; the reply is matched on it, so heartbeats and
 * unrelated messages can arrive in between.
 */

import { encode, encodeMessage } from "./updates.js";
import { hasSession, next } from "./session.js";

/** readToolCall -> read_tool_call */
function snakeCase(name) {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Build one AgentServerMessage carrying an exec request. */
export function execServerMessage(root, { id, execId, caseName, value }) {
  // protobufjs flattens oneofs, so the case name is a field of the message itself.
  return encodeMessage(root, {
    exec_server_message: {
      id,
      exec_id: execId,
      [snakeCase(caseName)]: value,
    },
  });
}

/** A tool call has been decided on; the UI renders it from here. */
export function toolCallStarted(root, { callId, toolType, args, modelCallId }) {
  return encode(root, {
    tool_call_started: {
      call_id: callId,
      model_call_id: modelCallId,
      tool_call: { [snakeCase(toolType)]: { args } },
    },
  });
}

/** The tool finished; the result rides along so the UI can render it. */
export function toolCallCompleted(root, { callId, toolType, args, result, modelCallId }) {
  return encode(root, {
    tool_call_completed: {
      call_id: callId,
      model_call_id: modelCallId,
      tool_call: { [snakeCase(toolType)]: { args, result } },
    },
  });
}

/**
 * One step of waiting for an exec reply with a matching id.
 *
 * A single blocking wait is wrong here: Cursor's stall detector gives up after 30
 * seconds of silence, and a Shell command can easily take longer than that. So the
 * wait is broken into steps, and the caller sends a heartbeat between them.
 *
 * @param {string} requestId
 * @param {number} id exec id
 * @param {number} [idleMs] how long to wait before reporting idle
 * @returns {Promise<{kind: "message", value: object}
 *   | {kind: "idle"}
 *   | {kind: "closed"}>}
 */
export async function nextExecReply(requestId, id, idleMs = 4000) {
  // `next` opens a session when there is none, which would resurrect one the client
  // has closed. Ask first.
  if (!hasSession(requestId)) return { kind: "closed" };

  const message = await next(requestId, idleMs);

  if (message === null) {
    // `next` returns null both when it timed out and when the session closed.
    // Ask the session which it was.
    return hasSession(requestId) ? { kind: "idle" } : { kind: "closed" };
  }

  const exec = message.exec_client_message;
  if (!exec) return { kind: "idle" }; // heartbeat, cancellation, unrelated frame
  if (Number(exec.id) !== Number(id)) return { kind: "idle" };

  return { kind: "message", value: exec };
}
