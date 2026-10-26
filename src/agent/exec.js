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
import { next } from "./session.js";

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
 * Wait for the exec reply with a matching id.
 *
 * @param {string} requestId
 * @param {number} id exec id
 * @param {number} timeoutMs
 * @returns {Promise<object|null>} the ExecClientMessage payload
 */
export async function waitForExec(requestId, id, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    const message = await next(requestId, remaining);
    if (!message) return null;

    const exec = message.exec_client_message;
    if (!exec) continue; // heartbeat, cancellation, or an unrelated frame
    if (Number(exec.id) !== Number(id)) continue;

    return exec;
  }
}
