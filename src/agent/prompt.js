/**
 * The system prompt.
 *
 * Cursor does not send one: the server is expected to supply it. This is a short
 * prompt that describes the environment honestly — a coding assistant inside an IDE,
 * answering in Markdown — without pretending to be Cursor's own agent.
 *
 * A request may override it with `custom_system_prompt`, which is what the IDE's
 * custom-instructions setting produces.
 */

/** Built-in prompt used when the request does not carry one. */
export const DEFAULT_SYSTEM_PROMPT = `You are a coding assistant inside the Cursor IDE.

Answer in Markdown. Be concise and concrete. When you show code, use fenced blocks
with a language tag. If a question depends on files you cannot see, say what you
would need rather than guessing.

You are talking to a developer working in a repository. Prefer solutions that fit
the code already there over new abstractions.`;

/** Resolve the system prompt for one turn. */
export function systemPrompt(runRequest) {
  const custom = runRequest?.custom_system_prompt;
  if (typeof custom === "string" && custom.trim().length > 0) return custom;
  return DEFAULT_SYSTEM_PROMPT;
}
