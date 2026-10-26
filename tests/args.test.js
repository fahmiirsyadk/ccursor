/**
 * Argument parsing.
 *
 * The important property: `run` forwards everything to Cursor. Cursor's flag set
 * is not ours to enumerate, so a token we happen to use elsewhere (--appimage,
 * --dry-run) must still reach the launcher untouched.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseArgs } from "../src/cli.js";

describe("parseArgs", () => {
  it("forwards every token after run", () => {
    const args = parseArgs(["run", "--inspect=9229", "--no-sandbox", "--appimage", "x"]);

    assert.equal(args.command, "run");
    assert.deepEqual(args.forward, ["--inspect=9229", "--no-sandbox", "--appimage", "x"]);
    // none of them were consumed as our own flags
    assert.equal(args.appimage, undefined);
    assert.equal(args.dryRun, undefined);
  });

  it("forwards a url argument", () => {
    const args = parseArgs(["run", "vscode://file/tmp"]);
    assert.deepEqual(args.forward, ["vscode://file/tmp"]);
  });

  it("accepts run with no arguments", () => {
    assert.deepEqual(parseArgs(["run"]), { command: "run", forward: [] });
  });

  it("parses boolean flags for other commands", () => {
    const args = parseArgs(["apply", "--dry-run", "--skip-installer", "--skip-seed"]);
    assert.equal(args.dryRun, true);
    assert.equal(args.skipInstaller, true);
    assert.equal(args.skipSeed, true);
  });

  it("parses value flags for other commands", () => {
    const args = parseArgs(["update", "--appimage", "/tmp/a.AppImage", "--drop-old"]);
    assert.equal(args.appimage, "/tmp/a.AppImage");
    assert.equal(args.dropOld, true);

    assert.equal(parseArgs(["rule", "--write", "AGENTS.md"]).write, "AGENTS.md");
    assert.equal(parseArgs(["update", "--install-dir", "/opt/x"]).installDir, "/opt/x");
  });

  it("rejects a value flag with no value", () => {
    assert.throws(() => parseArgs(["update", "--appimage"]), /needs a value/);
  });

  it("rejects unknown flags and commands", () => {
    assert.throws(() => parseArgs(["apply", "--bogus"]), /unrecognized/);
    assert.throws(() => parseArgs(["nonsense"]), /unknown command/);
  });

  it("handles global flags without a command", () => {
    assert.equal(parseArgs(["--version"]).version, true);
    assert.equal(parseArgs(["--help"]).help, true);
    assert.equal(parseArgs([]).command, undefined);
  });
});
