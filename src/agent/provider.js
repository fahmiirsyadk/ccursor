/**
 * Provider client.
 *
 * One streaming call, normalised into events the rest of the server understands:
 *
 *   {type: "text_delta",     text}
 *   {type: "thinking_delta", text}
 *   {type: "thinking_done",  signature?}
 *   {type: "tool_use_start", id, name}
 *   {type: "tool_use_delta", id, input}
 *   {type: "tool_use_done",  id, arguments}
 *   {type: "done",           stopReason, usage}
 *
 * Keeping the wire format here means the agent loop never sees SSE.
 */

/** Provider types understood by this module. */
export const SUPPORTED = new Set(["openai-chat", "anthropic"]);

/** Read the configured providers file and resolve one model. */
export function resolveModel(providers, id) {
  for (const provider of providers ?? []) {
    for (const model of provider.models ?? []) {
      if (model.id !== id && model.apiModel !== id) continue;
      return { provider, model, apiModel: model.apiModel ?? model.id };
    }
  }
  return null;
}

/** Header set for a provider request. */
function authHeaders(provider) {
  const key = provider.auth?.value ?? "";
  if (provider.type === "anthropic") {
    return {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    };
  }
  return {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };
}

/** Convert our message shape to OpenAI chat messages. */
function toOpenAiMessages(messages) {
  const out = [];

  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      });
      continue;
    }

    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const blocks = message.content ?? [];
    const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("");
    const images = blocks.filter((b) => b.type === "image" && typeof b.data === "string");
    const toolCalls = blocks
      .filter((b) => b.type === "tool_use")
      .map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));

    if (message.role === "assistant") {
      const entry = { role: "assistant", content: text };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
      continue;
    }

    if (images.length > 0) {
      // [OI] vision takes a block array with data URLs, not bare base64.
      out.push({
        role: message.role,
        content: [
          ...(text.length > 0 ? [{ type: "text", text }] : []),
          ...images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mimeType || "image/png"};base64,${image.data}` },
          })),
        ],
      });
      continue;
    }

    out.push({ role: message.role, content: text });
  }

  return out;
}

/** Convert our tool descriptors to OpenAI function tools. */
function toOpenAiTools(tools) {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    },
  }));
}

/** Split an SSE stream into event payloads. */
async function* sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "" || payload === "[DONE]") continue;
          try {
            yield JSON.parse(payload);
          } catch {
            /* a partial frame will be completed by the next chunk */
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Stream one completion from an OpenAI-compatible endpoint.
 *
 * @param {object} options
 * @param {object} options.provider entry from providers.json
 * @param {string} options.apiModel model name to send
 * @param {Array} options.messages provider-neutral messages
 * @param {Array} [options.tools]
 * @param {AbortSignal} [options.signal]
 */
export async function* streamOpenAi({ provider, apiModel, messages, tools, signal }) {
  const url = `${String(provider.baseUrl).replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: apiModel,
    messages: toOpenAiMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) {
    body.tools = toOpenAiTools(tools);
    body.tool_choice = "auto";
  }

  const response = await fetch(url, {
    method: "POST",
    headers: authHeaders(provider),
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${provider.name ?? provider.id} returned ${response.status}: ${detail.slice(0, 300)}`);
  }

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const pending = new Map();
  let stopReason = "end_turn";

  for await (const event of sseEvents(response)) {
    // A gateway can answer 200 and then report the failure inside the stream. Left
    // alone, that ends the turn with an empty answer and no explanation.
    if (event.error) {
      const message = event.error.message ?? JSON.stringify(event.error);
      throw new Error(`${provider.name ?? provider.id}: ${message}`);
    }

    if (event.usage) {
      usage.inputTokens = event.usage.prompt_tokens ?? usage.inputTokens;
      usage.outputTokens = event.usage.completion_tokens ?? usage.outputTokens;
      usage.cacheReadTokens = event.usage.prompt_tokens_details?.cached_tokens ?? 0;
    }

    const choice = event.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      yield { type: "thinking_delta", text: delta.reasoning_content };
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      yield { type: "text_delta", text: delta.content };
    }

    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0;
      if (call.id && !pending.has(index)) {
        pending.set(index, { id: call.id, name: call.function?.name ?? "", arguments: "" });
        yield { type: "tool_use_start", id: call.id, name: call.function?.name ?? "" };
      }
      const entry = pending.get(index);
      if (!entry) continue;
      const piece = call.function?.arguments ?? "";
      if (piece.length > 0) {
        entry.arguments += piece;
        yield { type: "tool_use_delta", id: entry.id, input: piece };
      }
    }

    if (choice.finish_reason) {
      stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";
    }
  }

  for (const entry of pending.values()) {
    yield { type: "tool_use_done", id: entry.id, name: entry.name, arguments: entry.arguments };
  }

  // A stream that produced nothing at all is a failure, not an empty answer.
  if (usage.inputTokens === 0 && usage.outputTokens === 0) {
    throw new Error(
      `${provider.name ?? provider.id} returned an empty response — the endpoint may be ` +
        "out of capacity or refusing the request",
    );
  }

  yield { type: "done", stopReason, usage };
}

/** Does this failure look like the provider refusing the image? */
export function looksLikeImageRejection(error) {
  const message = String(error?.message ?? error ?? "");
  return /image|vision|modalit|content[_ ]?type|supplier_request_rejected/i.test(message);
}

/**
 * Stream, and retry without images if the provider refuses them.
 *
 * A gateway can advertise nothing and still reject an image, so the capability
 * cannot be known up front. Trying and falling back is the only way to support both
 * kinds of endpoint without asking the user to configure it.
 *
 * The returned generator carries `droppedImages` so the caller can tell the user.
 *
 * @param {object} options
 * @param {Array} options.images image blocks present in the conversation
 * @param {"send"|"skip"|"try"} [options.policy]
 */
export function withImageFallback({ images = [], policy = "try", ...options }) {
  // stream() is an async generator, so this has to be one too: a sync generator
  // cannot yield from an async iterable.
  const attempt = async function* (messages) {
    yield* stream({ ...options, messages });
  };

  const generator = (async function* () {
    const maySend = policy !== "skip" && images.length > 0;

    if (!maySend) {
      yield* attempt(options.messages);
      return;
    }

    try {
      yield* attempt(options.messages);
    } catch (error) {
      if (!looksLikeImageRejection(error)) throw error;

      // Retry once, without the images, so the user keeps their text.
      const stripped = options.messages.map((message) => {
        if (!Array.isArray(message.content)) return message;
        const kept = message.content.filter((block) => block?.type !== "image");
        const onlyText = kept.every((block) => block.type === "text");
        return { ...message, content: onlyText ? kept.map((block) => block.text).join("") : kept };
      });

      generator.droppedImages = true;
      yield* attempt(stripped);
    }
  })();

  return generator;
}

/** Stream from whichever provider the model belongs to. */
export async function* stream({ provider, apiModel, messages, tools, signal }) {
  switch (provider.type) {
    case "openai-chat":
      yield* streamOpenAi({ provider, apiModel, messages, tools, signal });
      return;
    default:
      throw new Error(`provider type not supported yet: ${provider.type}`);
  }
}
