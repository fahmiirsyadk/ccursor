/**
 * The system message.
 *
 * Two sources, in Cursor's own order:
 *
 *   1. `user_info`  — where the model is: OS, shell, workspace path, date.
 *                     Built per turn by Cursor's component from the request's
 *                     environment, because every value in it changes.
 *   2. the prompt   — Cursor's agent prompt, extracted once by `apply`.
 *
 * On top of those, the text the request carries is appended:
 *
 *   custom_system_prompt                    the user's custom instructions
 *   system_prompt_spec.replace              a whole replacement prompt
 *   system_prompt_spec.append               text appended to the prompt
 *   request_context.cloud_rule              AGENTS.md contents
 *   request_context.rules                   .cursor/rules and their content
 *   request_context.non_file_rules          rules that live outside the workspace
 *   user_message.subagent_system_reminder   a reminder Cursor attaches to a subagent
 *
 * Those are passed through verbatim, joined by a blank line. No wrapper tags, no
 * reordering, no summary: adding framing of our own would be a prompt this project
 * invented, and it would claim things about the IDE that may not be true.
 *
 * When none of it is present, no system message is sent at all.
 */

import { requestContext } from "./request.js";

/** Content of one cursor rule, as the client sent it. */
function ruleText(rule) {
  if (!rule || typeof rule !== "object") return "";
  return typeof rule.content === "string" ? rule.content.trim() : "";
}

/**
 * Build the system message from what the client sent.
 *
 * @param {object} runRequest decoded agent.v1.AgentRunRequest
 * @param {string} [base] Cursor's prompt, or "" when it was never extracted
 * @returns {string} the system message, or "" when there is nothing to send
 */
export function systemPrompt(runRequest, base = "") {
  const context = requestContext(runRequest);
  const parts = [];

  // A whole replacement wins over everything: that is what the field means, and it
  // is the mechanism Cursor gives a client for overriding the prompt.
  const spec = runRequest?.system_prompt_spec;
  const replaced = typeof spec?.replace === "string" ? spec.replace.trim() : "";
  if (replaced.length > 0) return finish(replaced, spec);

  if (typeof base === "string" && base.trim().length > 0) parts.push(base.trim());

  const custom = runRequest?.custom_system_prompt;
  if (typeof custom === "string" && custom.trim().length > 0) parts.push(custom.trim());

  const agents = context?.cloud_rule;
  if (typeof agents === "string" && agents.trim().length > 0) parts.push(agents.trim());

  for (const rule of [...(context?.rules ?? []), ...(context?.non_file_rules ?? [])]) {
    const text = ruleText(rule);
    if (text.length > 0) parts.push(text);
  }

  const reminder = runRequest?.action?.user_message_action?.user_message?.subagent_system_reminder;
  if (typeof reminder === "string" && reminder.trim().length > 0) parts.push(reminder.trim());

  return finish(parts.join("\n\n"), spec);
}

/** Append whatever the request asked to append, and drop an empty result. */
function finish(prompt, spec) {
  const appended = typeof spec?.append === "string" ? spec.append.trim() : "";
  if (appended.length === 0) return prompt;
  return prompt.length > 0 ? `${prompt}\n\n${appended}` : appended;
}

/**
 * The messages to send: a system message only when there is something in it.
 *
 * @param {object} runRequest decoded agent.v1.AgentRunRequest
 * @param {Array} turns the conversation
 * @param {{base?: string, userInfo?: string}} [context] what Cursor contributes
 */
export function withSystemPrompt(runRequest, turns, { base = "", userInfo = "" } = {}) {
  const preamble = [userInfo.trim(), base.trim()].filter((part) => part.length > 0).join("\n\n");
  const system = systemPrompt(runRequest, preamble);
  return system.length > 0 ? [{ role: "system", content: system }, ...turns] : turns;
}
