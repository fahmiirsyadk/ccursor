/**
 * The system message: Cursor's user_info block, Cursor's prompt, then the request.
 *
 * The parts that need an installed Cursor are skipped when there is none; the
 * composition rules are not, because they are what decides what the model is told.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { discover } from "../src/locate.js";
import { promptRegion, reset } from "../src/prompt/bundle.js";
import { extractBasePrompt } from "../src/prompt/base.js";
import { environment, userInfo } from "../src/prompt/user-info.js";
import { systemPrompt, withSystemPrompt } from "../src/agent/prompt.js";

// Resolved before any test overrides HOME: discovery reads it.
const APP_ROOT = discover().appRoot;
const skip = APP_ROOT ? false : "no Cursor install on this machine";

/** A request that carries a workspace, the way the client sends one. */
function requestWith(env, extra = {}) {
  return {
    ...extra,
    action: { user_message_action: { request_context: { env } } },
  };
}

describe("system message composition", () => {
  it("sends nothing when there is nothing to send", () => {
    assert.equal(systemPrompt({}), "");
    assert.deepEqual(withSystemPrompt({}, [{ role: "user", content: "hi" }]), [
      { role: "user", content: "hi" },
    ]);
  });

  it("puts user_info first, then Cursor's prompt, then the request's text", () => {
    const messages = withSystemPrompt(
      { action: { user_message_action: { request_context: { cloud_rule: "# Rules" } } } },
      [{ role: "user", content: "hi" }],
      { userInfo: "<user_info>\nWorkspace Path: /repo\n</user_info>", base: "You are Cursor." },
    );

    assert.equal(messages[0].role, "system");
    assert.equal(
      messages[0].content,
      "<user_info>\nWorkspace Path: /repo\n</user_info>\n\nYou are Cursor.\n\n# Rules",
    );
  });

  it("omits a part that is empty rather than leaving a gap", () => {
    const messages = withSystemPrompt({}, [], { userInfo: "", base: "You are Cursor." });
    assert.equal(messages[0].content, "You are Cursor.");

    const onlyInfo = withSystemPrompt({}, [], { userInfo: "<user_info />", base: "" });
    assert.equal(onlyInfo[0].content, "<user_info />");
  });

  it("lets system_prompt_spec.replace win over Cursor's prompt and user_info", () => {
    const messages = withSystemPrompt(
      { system_prompt_spec: { replace: "REPLACED" } },
      [],
      { userInfo: "<user_info />", base: "You are Cursor." },
    );

    assert.equal(messages[0].content, "REPLACED");
  });
});

describe("prompt region", () => {
  it("spans every function that declares a section", () => {
    const source = [
      'var unrelated="x";',
      'function a(){return Kz("section",{title:"general",children:[]})}',
      "function helper(){return 1}",
      'function b(){return Kz("section",{title:"main_goal",children:[]})}',
      'var tail="y";',
    ].join("");

    const region = promptRegion(source);
    assert.match(region, /title:"general"/);
    assert.match(region, /title:"main_goal"/);
    assert.match(region, /function helper/);
    assert.equal(region.includes("unrelated"), false);
  });

  it("fails loudly when Cursor's shape changes", () => {
    assert.throws(() => promptRegion('function a(){return "nothing"}'), /Cursor changed shape/);
  });
});

describe("Cursor's prompt", { skip }, () => {
  it("extracts the general agent prompt", () => {
    reset();
    const prompt = extractBasePrompt(APP_ROOT);

    assert.match(prompt, /^You are Cursor\./);
    assert.match(prompt, /<general>/);
    assert.match(prompt, /<main_goal>/);
    assert.ok(prompt.length > 500);
  });
});

describe("user_info", { skip }, () => {
  it("states the workspace, shell and date the request carried", () => {
    const block = userInfo(
      requestWith({
        os_version: "linux 6.8.0",
        workspace_paths: ["/home/user/repo"],
        shell: "/bin/bash",
        time_zone: "Asia/Jakarta",
      }),
      { appRoot: APP_ROOT },
    );

    assert.match(block, /^<user_info>/);
    assert.match(block, /OS Version: linux 6\.8\.0/);
    assert.match(block, /Shell: \/bin\/bash/);
    assert.match(block, /Workspace Path: \/home\/user\/repo/);
    assert.match(block, /Today's date: \d{4}-\d{2}-\d{2}/);
  });

  it("lists every root when there is more than one", () => {
    const block = userInfo(
      requestWith({ workspace_paths: ["/a/one", "/b/two"], shell: "bash" }),
      { appRoot: APP_ROOT },
    );

    assert.match(block, /Workspace Paths:/);
    assert.match(block, /- \/a\/one/);
    assert.match(block, /- \/b\/two/);
  });

  it("adds the worktree note only for a Cursor worktree", () => {
    const plain = userInfo(requestWith({ workspace_paths: ["/home/user/repo"] }), {
      appRoot: APP_ROOT,
    });
    assert.equal(plain.includes("Cursor worktree"), false);

    const worktree = userInfo(
      requestWith({ workspace_paths: ["/home/user/.cursor/worktrees/repo/abc"] }),
      { appRoot: APP_ROOT },
    );
    assert.match(worktree, /Cursor worktree/);
  });

  it("builds nothing when the request carries no environment", () => {
    assert.equal(userInfo({}, { appRoot: APP_ROOT }), "");
    assert.equal(userInfo({ action: { user_message_action: {} } }, { appRoot: APP_ROOT }), "");
  });
});

describe("environment mapping", () => {
  it("translates the proto field names the prompt component reads", () => {
    const env = environment(
      requestWith({
        os_version: "darwin 24",
        workspace_paths: ["/repo", "", 7],
        shell: "zsh",
        project_folder: "/repo",
        process_working_directory: "/repo/src",
        time_zone: "Europe/Berlin",
        terminals_folder: "/repo/.terminals",
        is_working_dir_home_dir: true,
      }),
    );

    assert.deepEqual(env, {
      osVersion: "darwin 24",
      workspacePaths: ["/repo"],
      shell: "zsh",
      projectFolder: "/repo",
      processWorkingDirectory: "/repo/src",
      timeZone: "Europe/Berlin",
      terminalsFolder: "/repo/.terminals",
      isWorkingDirHomeDir: true,
    });
  });

  it("is empty, not undefined, when the request carries nothing", () => {
    const env = environment({});
    assert.deepEqual(env.workspacePaths, []);
    assert.equal(env.osVersion, "");
  });
});

describe("cached prompt", () => {
  it("is read from the state directory and survives a missing file", async () => {
    const { basePrompt } = await import("../src/prompt/base.js");
    const { promptFile } = await import("../src/paths.js");

    // Point the state at a temporary directory: the real one belongs to the running
    // install, and a test must not overwrite or delete it.
    const saved = process.env.CURSOR_BYOK_STATE;
    const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cursor-byok-prompt-"));

    try {
      process.env.CURSOR_BYOK_STATE = tmp;
      assert.equal(basePrompt(), "");

      fs.mkdirSync(path.dirname(promptFile()), { recursive: true });
      fs.writeFileSync(promptFile(), "PROMPT\n");
      assert.equal(basePrompt(), "PROMPT");
    } finally {
      if (saved === undefined) delete process.env.CURSOR_BYOK_STATE;
      else process.env.CURSOR_BYOK_STATE = saved;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
