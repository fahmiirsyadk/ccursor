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

/** Prompt for a subagent, which has a narrower job than the parent. */
const SUBAGENT_PROMPT = `You are a subagent inside the Cursor IDE, working on one task
that a parent agent delegated to you.

Do the work yourself with the tools you have. You cannot delegate: there is no Task
tool, and asking for one will be refused. Read what you need, then report back.

Your final message is the only thing the parent sees, so it must stand alone: state
the answer, name the files or paths that matter, and leave out the play-by-play.`;

/** What each subagent type is for. Kept short: the task prompt carries the detail. */
const SUBAGENT_ROLES = {
  explore: "You are exploring a codebase. Report structure, entry points and the files that matter. Do not change anything.",
  debug: "You are diagnosing a failure. Find the cause and say what would fix it.",
  bash: "You are running commands. Report what they did and what they printed.",
  shell: "You are running commands. Report what they did and what they printed.",
  media_review: "You are reviewing media. Describe what you can see or read.",
  cursor_guide: "You are answering questions about Cursor itself.",
  watch_video: "You are reviewing a video. Report what happens in it.",
};

/**
 * Resolve the system prompt for one turn.
 *
 * @param {object} runRequest
 * @param {string} [subagent] subagent type, when this run is a subagent
 */
export function systemPrompt(runRequest, subagent = "") {
  const custom = runRequest?.custom_system_prompt;
  if (typeof custom === "string" && custom.trim().length > 0) return custom;

  if (subagent) {
    const role = SUBAGENT_ROLES[subagent];
    return role ? `${SUBAGENT_PROMPT}

${role}` : SUBAGENT_PROMPT;
  }

  return DEFAULT_SYSTEM_PROMPT;
}
