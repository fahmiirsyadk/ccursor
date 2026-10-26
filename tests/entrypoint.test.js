/**
 * The CLI entry point must work when invoked through a symlink.
 *
 * `npm link` — documented in the README — installs a symlink into the global bin
 * directory. The first version compared process.argv[1] against the module path with
 * path.resolve(), which does not follow symlinks, so the guard was false, main()
 * never ran, and the process exited 0. Silent success is the worst failure mode.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { after, describe, it } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-entry-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const cliPath = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "src",
  "cli.js",
);

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" });
}

describe("entry point", () => {
  it("runs when invoked directly", () => {
    const out = run(process.execPath, [cliPath, "--version"]);
    assert.match(out, /^cursor-byok \d+\.\d+\.\d+/);
  });

  it("runs when invoked through a symlink", () => {
    const link = path.join(tmpRoot, "cursor-byok");
    fs.symlinkSync(cliPath, link);

    const out = run(process.execPath, [link, "--version"]);

    assert.match(out, /^cursor-byok \d+\.\d+\.\d+/);
  });

  it("runs when the symlink is executable and invoked directly", () => {
    const link = path.join(tmpRoot, "cursor-byok-exec");
    fs.symlinkSync(cliPath, link);
    fs.chmodSync(cliPath, 0o755);

    const out = run(link, ["--version"]);

    assert.match(out, /^cursor-byok \d+\.\d+\.\d+/);
  });

  it("does not run main() when merely imported", async () => {
    // Importing must not print usage or exit the test process.
    const mod = await import("../src/cli.js");
    assert.equal(typeof mod.main, "function");
    assert.equal(typeof mod.parseArgs, "function");
  });
});
