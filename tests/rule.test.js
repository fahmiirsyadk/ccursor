/**
 * The rule helper appends agent guidance, and must be idempotent.
 *
 * The first version keyed presence on the heading, so a project that restated the
 * rule under its own heading got a duplicate appended. The sentinel is now a
 * phrase from the rule body.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { cmdRule } from "../src/cli.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-rule-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const SENTINEL = "Never put two files' contents into a single";

describe("rule", () => {
  it("creates the file and appends the rule", () => {
    const target = path.join(tmpRoot, "fresh.md");

    assert.equal(cmdRule({ write: target }), 0);

    const written = fs.readFileSync(target, "utf8");
    assert.ok(written.includes(SENTINEL));
    assert.ok(written.includes("one Write call per file"));
  });

  it("is idempotent", () => {
    const target = path.join(tmpRoot, "twice.md");

    cmdRule({ write: target });
    const first = fs.readFileSync(target, "utf8");
    cmdRule({ write: target });

    assert.equal(fs.readFileSync(target, "utf8"), first);
    assert.equal(first.split(SENTINEL).length - 1, 1);
  });

  it("treats a restated rule as present", () => {
    const target = path.join(tmpRoot, "restated.md");
    fs.writeFileSync(
      target,
      `# Project notes\n\n## Tool calling\n\n${SENTINEL} \`contents\` field.\n`,
    );
    const before = fs.readFileSync(target, "utf8");

    cmdRule({ write: target });

    assert.equal(fs.readFileSync(target, "utf8"), before);
  });

  it("preserves existing content and separates it from the rule", () => {
    const target = path.join(tmpRoot, "existing.md");
    fs.writeFileSync(target, "# Existing\n\nSome notes.\n");

    cmdRule({ write: target });

    const written = fs.readFileSync(target, "utf8");
    assert.ok(written.startsWith("# Existing\n\nSome notes."));
    assert.ok(written.includes(SENTINEL));
  });
});
