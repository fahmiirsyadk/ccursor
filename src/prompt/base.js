/**
 * Cursor's main agent prompt.
 *
 * Extracted once by `apply` and cached as text, so a turn does not pay for parsing
 * the workbench. The prompt is Cursor's own: this module selects a builder and
 * renders it, and writes no prompt content of its own.
 *
 * The environment block (`user_info`) is not part of this text because it changes per
 * turn; see `user-info.js`.
 */

import fs from "node:fs";
import path from "node:path";

import { promptFile } from "../paths.js";
import { load } from "./bundle.js";
import { render } from "./render.js";

/**
 * The props the builder needs.
 *
 * Deliberately minimal: the builder renders a section only when the props that
 * section reads are present, so this produces the general agent prompt without the
 * model-specific variants (a fast model gets a different preamble) or the cloud
 * variants (which describe a virtual machine this is not).
 */
function baseProps() {
  return {
    nameWeTellTheModelToCallItself: "Cursor",
    browserTools: false,
    requestContext: { env: { workspacePaths: [] }, rules: [], nonFileRules: [], tools: [] },
    featureFlags: {},
    toolInfo: {
      allTools: {
        READ: { name: "Read" },
        EDIT: { name: "Edit" },
        SHELL: { name: "Shell" },
        GREP: { name: "Grep" },
        GLOB: { name: "Glob" },
        APPLY_PATCH: { name: "ApplyPatch" },
      },
    },
    modelInfo: {},
  };
}

/**
 * Build the prompt from an installed Cursor.
 *
 * @param {string} appRoot Cursor's `resources/app`
 * @returns {string} the prompt text
 * @throws when the bundle is missing or the builder is not where it was
 */
export function extractBasePrompt(appRoot) {
  const { context } = load(appRoot);

  // `n5` is the general agent prompt: "You are <name>." followed by the behaviour
  // sections. Other roots beside it are the fast-model and cloud variants.
  const build = context.n5;
  if (typeof build !== "function") {
    throw new Error("prompt builder not found in cursor-agent-exec; Cursor changed shape");
  }

  const text = render(build({ props: baseProps() }));
  if (text.length < 500) {
    throw new Error(`extracted prompt is only ${text.length} characters; Cursor changed shape`);
  }

  return text;
}

/** Write the prompt to the state directory. */
export function saveBasePrompt(appRoot) {
  const text = extractBasePrompt(appRoot);
  const file = promptFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${text}\n`);
  return text;
}

/**
 * The cached prompt.
 *
 * Read on every turn rather than held in memory: `apply` can replace it while the
 * server is running, and a stale prompt is worse than a small read.
 *
 * @returns {string} the prompt, or "" when it was never extracted
 */
export function basePrompt() {
  try {
    return fs.readFileSync(promptFile(), "utf8").trim();
  } catch {
    return "";
  }
}
