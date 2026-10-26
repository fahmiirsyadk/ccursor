/**
 * Cursor's `user_info` block: where the model is working.
 *
 * This is the block that tells the model its operating system, shell, workspace
 * path and today's date. Without it the model has no idea where the repository is,
 * so it guesses an absolute path — and then hands that guess to a subagent, which
 * searches somewhere that does not exist.
 *
 * The block is built by Cursor's own component from the environment in the request,
 * not written here: the text, the order and the wording are Cursor's.
 *
 * It is rendered per turn because every value in it changes per turn.
 */

import fs from "node:fs";
import path from "node:path";

import { requestContext } from "../agent/request.js";
import { load } from "./bundle.js";
import { render } from "./render.js";

/** A string field, or "" when the request did not carry it. */
const text = (value) => (typeof value === "string" ? value : "");

/** A repeated string field, with empty entries dropped. */
const list = (value) =>
  Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.length > 0) : [];

/**
 * The environment from the request, in the shape the prompt component expects.
 *
 * The request decodes to the proto field names (`workspace_paths`); the prompt code
 * reads the generated names (`workspacePaths`). This is that translation, spelled
 * out rather than derived, so a new field is a deliberate decision.
 */
export function environment(runRequest) {
  const env = requestContext(runRequest)?.env ?? {};

  return {
    osVersion: text(env.os_version),
    workspacePaths: list(env.workspace_paths),
    shell: text(env.shell),
    projectFolder: text(env.project_folder),
    processWorkingDirectory: text(env.process_working_directory),
    timeZone: text(env.time_zone),
    terminalsFolder: text(env.terminals_folder),
    isWorkingDirHomeDir: env.is_working_dir_home_dir === true,
  };
}

/** Today, as `YYYY-MM-DD`, in the user's own zone when the request carries one. */
function today(timeZone) {
  const now = new Date();
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || undefined,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    // An unknown zone must not cost the model the rest of the block.
    return now.toISOString().slice(0, 10);
  }
}

/**
 * Is the workspace a git checkout?
 *
 * `.git` is a directory in a normal clone and a file in a worktree or submodule, so
 * existence is the right test for both. Stating this from the filesystem keeps the
 * block truthful; guessing either way would be worse than omitting the line.
 */
function gitRepos(paths) {
  return paths.filter((workspace) => {
    try {
      return fs.existsSync(path.join(workspace, ".git"));
    } catch {
      return false;
    }
  });
}

/**
 * Cursor's `user_info` block for this turn.
 *
 * @param {object} runRequest decoded agent.v1.AgentRunRequest
 * @param {{appRoot: string}} options the install the prompt is read from
 * @returns {string} the block, or "" when it cannot be built
 */
export function userInfo(runRequest, { appRoot } = {}) {
  const env = environment(runRequest);
  if (env.workspacePaths.length === 0 && env.osVersion.length === 0) return "";

  const { context } = load(appRoot);
  const component = context.Z8;
  if (typeof component !== "function") {
    throw new Error("user_info component not found in cursor-agent-exec; Cursor changed shape");
  }

  const repos = gitRepos(env.workspacePaths);

  return render(
    component({
      env,
      dsv3: false,
      hasGitRepos: repos.length > 0,
      gitRepoInfoComplete: true,
      gitRepos: repos.map((workspace) => ({ path: workspace })),
      todaysDate: today(env.timeZone),
      terminalsFolder: env.terminalsFolder || undefined,
      metaAgentNotesEnabled: false,
      displayTodaysDate: true,
      displayGitRepoStatusLine: true,
      displayUnknownWorkspacePath: false,
      agentStorePathsAdvertisedInPromptEnabled: false,
    }),
  );
}
