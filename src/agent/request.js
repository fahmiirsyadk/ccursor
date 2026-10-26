/**
 * Turn a decoded AgentRunRequest into something a provider can be called with.
 *
 * The request carries conversation history in three different places, depending on
 * how old the conversation is and whether the client kept a local copy:
 *
 *   action.user_message_action.conversation_history   plain protobuf messages
 *   conversation_state.root_prompt_messages_json      blob ids, one per message
 *   conversation_state.turns                          blob ids, one per turn
 *
 * All three are read, oldest source first, and merged without duplicates. The
 * result is Cursor's own provider-neutral message shape — a role plus a string or
 * an array of blocks — which is what every provider adapter consumes.
 */

import { readBlobJson } from "./blobs.js";

/** Roles a provider message may have. */
export const ROLE_USER = "user";
export const ROLE_ASSISTANT = "assistant";
export const ROLE_TOOL = "tool";
export const ROLE_SYSTEM = "system";

/** Join the text parts of a block array. */
function textOf(blocks) {
  return (blocks ?? [])
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

/** Join the text parts of a protobuf content array. */
function protoTextOf(parts) {
  return (parts ?? [])
    .filter((part) => typeof part?.text?.text === "string")
    .map((part) => part.text.text)
    .join("");
}

/**
 * Read one inline image.
 *
 * SelectedImage carries its bytes in a oneof: `data` directly, or
 * `blob_id_with_data` with the bytes alongside the id. An image that was uploaded
 * rather than inlined has only an id, and its bytes never reach this process, so it
 * is skipped with a note instead of becoming an empty block.
 */
function readImage(image) {
  const mimeType = image?.mime_type || "image/png";

  const raw =
    image?.data?.length
      ? image.data
      : image?.blob_id_with_data?.data?.length
        ? image.blob_id_with_data.data
        : null;

  if (!raw) return null;
  return {
    type: "image",
    mimeType,
    data: Buffer.isBuffer(raw) ? raw.toString("base64") : Buffer.from(raw).toString("base64"),
  };
}

/** Every inline image attached to this turn. */
export function imagesFrom(runRequest) {
  const selected = runRequest?.action?.user_message_action?.user_message?.selected_context;
  const out = [];

  for (const image of selected?.selected_images ?? []) {
    const block = readImage(image);
    if (block) out.push(block);
  }

  return out;
}

/** Convert a protobuf ConversationHistoryMessage. */
function fromHistoryMessage(message) {
  if (message.user) {
    const blocks = [];
    const text = protoTextOf(message.user.content);
    if (text.length > 0) blocks.push({ type: "text", text });

    for (const part of message.user.content ?? []) {
      // History images are already base64 strings, not bytes.
      if (typeof part?.image?.data === "string" && part.image.data.length > 0) {
        blocks.push({
          type: "image",
          mimeType: part.image.mime_type || "image/png",
          data: part.image.data,
        });
      }
    }

    return {
      role: ROLE_USER,
      content: blocks.some((block) => block.type === "image") ? blocks : text,
    };
  }

  if (message.assistant) {
    const blocks = [];
    for (const part of message.assistant.content ?? []) {
      if (part.text) blocks.push({ type: "text", text: part.text.text ?? "" });
      else if (part.reasoning) blocks.push({ type: "thinking", text: part.reasoning.text ?? "" });
      else if (part.tool_call) {
        blocks.push({
          type: "tool_use",
          id: part.tool_call.tool_call_id ?? "",
          name: part.tool_call.tool_name ?? "",
          input: parseJson(part.tool_call.args_json),
        });
      }
    }
    return { role: ROLE_ASSISTANT, content: collapse(blocks) };
  }

  if (message.tool) {
    return {
      role: ROLE_TOOL,
      toolCallId: message.tool.tool_call_id ?? "",
      toolName: message.tool.tool_name ?? "",
      content: protoTextOf(message.tool.content),
      isError: message.tool.is_error === true,
    };
  }

  return null;
}

function parseJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

/** A message whose blocks are all text becomes a plain string, as providers prefer. */
function collapse(blocks) {
  if (blocks.length === 0) return "";
  if (blocks.every((block) => block.type === "text")) return textOf(blocks);
  return blocks;
}

/** Read one history entry that is stored as a blob id inside a bytes field. */
function fromBlobEntry(entry) {
  const id = Buffer.isBuffer(entry) ? entry.toString("utf8") : String(entry ?? "");
  if (!id) return null;
  return readBlobJson(id);
}

/**
 * A turn blob holds the messages of one round. Older builds stored the array
 * directly, newer ones wrap it, so both shapes are accepted.
 */
function messagesFromTurn(entry) {
  const turn = fromBlobEntry(entry);
  if (!turn) return [];
  if (Array.isArray(turn)) return turn;
  if (Array.isArray(turn.messages)) return turn.messages;
  return [];
}

/** Normalise a message that came out of a blob. */
function normalise(message) {
  if (!message || typeof message !== "object") return null;
  if (typeof message.role !== "string") return null;

  const content = Array.isArray(message.content)
    ? message.content.filter((block) => block && typeof block.type === "string")
    : typeof message.content === "string"
      ? message.content
      : "";

  const out = { role: message.role, content };
  if (typeof message.toolCallId === "string") out.toolCallId = message.toolCallId;
  if (typeof message.toolName === "string") out.toolName = message.toolName;
  if (typeof message.isError === "boolean") out.isError = message.isError;
  return out;
}

/** Stable key so the same message is not added twice. */
function fingerprint(message) {
  const body = typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content);
  return `${message.role}:${body}:${message.toolCallId ?? ""}`;
}

/**
 * The user's text for this turn.
 *
 * Usually it is in the run request. When the client queues a message it arrives
 * first as a conversation action, so the caller may pass that along.
 */
export function userText(runRequest, queued) {
  const fromRequest = runRequest?.action?.user_message_action?.user_message?.text;
  if (typeof fromRequest === "string" && fromRequest.length > 0) return fromRequest;
  if (typeof queued === "string" && queued.length > 0) return queued;

  const resume = runRequest?.action?.resume_action;
  if (typeof resume?.user_message?.text === "string") return resume.user_message.text;
  return "";
}

/**
 * Assemble the conversation for this turn.
 *
 * @param {object} runRequest decoded agent.v1.AgentRunRequest
 * @param {string} [queued] text that arrived before the run request
 * @returns {Array<{role: string, content: any}>}
 */
export function conversation(runRequest, queued) {
  const action = runRequest?.action ?? {};
  const state = runRequest?.conversation_state ?? {};
  const messages = [];

  for (const message of action.user_message_action?.conversation_history?.messages ?? []) {
    const converted = fromHistoryMessage(message);
    if (converted) messages.push(converted);
  }

  for (const entry of state.root_prompt_messages_json ?? []) {
    const message = normalise(fromBlobEntry(entry));
    if (message) messages.push(message);
  }

  for (const turn of state.turns ?? []) {
    for (const raw of messagesFromTurn(turn)) {
      const message = normalise(raw);
      if (message) messages.push(message);
    }
  }

  // Blob-based history and the protobuf copy overlap; keep the first of each.
  const seen = new Set();
  const unique = [];
  for (const message of messages) {
    const key = fingerprint(message);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(message);
  }

  const text = userText(runRequest, queued);
  const images = imagesFrom(runRequest);

  if (text.length > 0 || images.length > 0) {
    const last = unique[unique.length - 1];
    const alreadyThere = last?.role === ROLE_USER && last.content === text && images.length === 0;

    if (!alreadyThere) {
      // A turn with images needs block content; text alone cannot carry them.
      const content =
        images.length === 0
          ? text
          : [...(text.length > 0 ? [{ type: "text", text }] : []), ...images];
      unique.push({ role: ROLE_USER, content });
    }
  }

  return unique;
}

/** Which model the client asked for. */
export function modelId(runRequest) {
  return (
    runRequest?.requested_model?.model_id ||
    runRequest?.model_details?.model_name ||
    ""
  );
}

/**
 * The subagent type, when this run *is* a subagent.
 *
 * Cursor runs a subagent in its own session with its own RunSSE, and marks the run
 * request with `subagent_type_name`. Empty means this is a top-level turn.
 *
 * @returns {string} e.g. "explore", or "" for a top-level turn
 */
export function subagentType(runRequest) {
  const name = runRequest?.subagent_type_name;
  return typeof name === "string" ? name.trim().toLowerCase().replace(/-/g, "_") : "";
}

/** Conversation id, used for logs and for resuming a run. */
export function conversationId(runRequest) {
  return runRequest?.conversation_id || "";
}

/** Agent mode as a name: "agent", "ask", "plan", ... */
export function modeName(runRequest, root) {
  const value = runRequest?.conversation_state?.mode;
  if (typeof value !== "number") return "agent";
  try {
    const enumType = root.lookupEnum("agent.v1.AgentMode");
    const name = Object.entries(enumType.values).find(([, number]) => number === value)?.[0];
    return (name ?? "AGENT_MODE_AGENT").replace("AGENT_MODE_", "").toLowerCase();
  } catch {
    return "agent";
  }
}
