/**
 * Patch logic is the risky part, so it gets real fixtures.
 *
 * Each fixture reproduces the shape Cursor's minified bundle actually has around
 * the guard, including the surrounding code the anchors rely on. If a future
 * Cursor release changes that shape, these tests are the first thing to fail.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import * as bundles from "../src/bundles.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-byok-test-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** A bundle carrying both guards, in the order Cursor emits them. */
function makeBundle() {
  return (
    "var x={subscriptionChangedListener=(h,p)=>{Iug({isLocalMode:fl.localMode})" +
    "&&p===Yr.FREE&&h!==Yr.FREE&&this.setUseKey(!1)}" +
    ",migrate:1};" +
    "function GLC({t:e,n:i}){if(i.useClaudeKey)for(const r of o1l)t.removeModel(r);" +
    "}Usp({isLocalMode:mc.localMode})&&i.useKey&&(AGo(t," +
    '"[local-agent][settings] source=admin-policy action=disable-openai-key ' +
    'byokDisabled=true previousUseKey=true"),' +
    'n.setApplicationUserPersistentStorage("useKey",!1)),' +
    'i.useClaudeKey&&n.setApplicationUserPersistentStorage("useClaudeKey",!1);'
  );
}

describe("subscription guard", () => {
  it("neutralises the downgrade callback", () => {
    const [patched, state] = bundles.patchSubscription(makeBundle());

    assert.equal(state, "patched");
    assert.ok(patched.includes("&&void 0}"));
    assert.ok(!patched.includes("setUseKey(!1)"));
    // the surrounding comparison logic must survive untouched
    assert.ok(patched.includes("p===Yr.FREE&&h!==Yr.FREE"));
  });

  it("is idempotent", () => {
    const [once] = bundles.patchSubscription(makeBundle());
    const [twice, state] = bundles.patchSubscription(once);

    assert.equal(state, "already");
    assert.equal(twice, once);
  });

  it("reports a missing anchor instead of guessing", () => {
    const [, state] = bundles.patchSubscription("var unrelated=1;");
    assert.equal(state, "not-found");
  });
});

describe("admin policy guard", () => {
  it("neutralises the policy-driven reset", () => {
    const [patched, state] = bundles.patchAdminPolicy(makeBundle());

    assert.equal(state, "patched");
    assert.ok(!patched.includes("action=disable-openai-key"));
    assert.ok(patched.includes("setApplicationUserPersistentStorage")); // claude line survives
    assert.ok(patched.includes("&&!1"));
  });

  it("is idempotent", () => {
    const [once] = bundles.patchAdminPolicy(makeBundle());
    const [twice, state] = bundles.patchAdminPolicy(once);

    assert.equal(state, "already");
    assert.equal(twice, once);
  });

  it("leaves an unrelated marker alone", () => {
    const data = 'function f(){switch(t){case"admin-policy":return 1}}';
    const [, state] = bundles.patchAdminPolicy(data);
    assert.equal(state, "already");
  });
});

describe("detection helpers", () => {
  it("reflects the patched state", () => {
    const original = makeBundle();
    assert.equal(bundles.subscriptionPatched(original), false);
    assert.equal(bundles.adminPolicyPatched(original), false);

    let patched = bundles.patchSubscription(original)[0];
    patched = bundles.patchAdminPolicy(patched)[0];

    assert.equal(bundles.subscriptionPatched(patched), true);
    assert.equal(bundles.adminPolicyPatched(patched), true);
  });
});

describe("patchBundle", () => {
  it("raises on an unknown shape", () => {
    const target = path.join(tmpRoot, "unknown.js");
    fs.writeFileSync(target, "nothing to patch here");

    assert.throws(() => bundles.patchBundle(target), bundles.PatchError);
  });

  it("writes only when needed", () => {
    const target = path.join(tmpRoot, "workbench.desktop.main.js");
    fs.writeFileSync(target, makeBundle());

    const first = bundles.patchBundle(target);
    assert.equal(first.changed, true);

    const second = bundles.patchBundle(target);
    assert.equal(second.changed, false);
    assert.equal(second.subscription, "already");
  });

  it("returns the bundle paths for an install", () => {
    const appRoot = path.join(tmpRoot, "app");
    const dir = path.join(appRoot, "out", "vs", "workbench");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "workbench.desktop.main.js"), "");
    fs.writeFileSync(path.join(dir, "workbench.glass.main.js"), "");

    const found = bundles.bundlePaths(appRoot).map((f) => path.basename(f));
    assert.deepEqual(found, ["workbench.desktop.main.js", "workbench.glass.main.js"]);
  });
});

describe("a hook an earlier installer left behind", () => {
  const start = "/* CURSOR-BYOK-HOOK-START */";
  const end = "/* CURSOR-BYOK-HOOK-END */";

  it("is removed from the bundle", () => {
    assert.equal(bundles.stripForeignHook(`before${start}BODY${end};after`), "before;after");
    assert.equal(bundles.stripForeignHook("nothing here"), "nothing here");
  });

  it("is removed more than once, if it was injected twice", () => {
    assert.equal(bundles.stripForeignHook(`${start}A${end}${start}B${end}z`), "z");
  });

  it("is left alone when the block never closes", () => {
    // Truncating at an unclosed marker would destroy the bundle.
    const broken = `before${start}unterminated`;
    assert.equal(bundles.stripForeignHook(broken), broken);
  });

  it("is stripped and reported by patchBundle", () => {
    const target = path.join(tmpRoot, "hooked.desktop.main.js");
    fs.writeFileSync(target, `${start}(function(){})()${end};${makeBundle()}`);

    const outcome = bundles.patchBundle(target);
    assert.equal(outcome.foreignHook, true);

    const written = fs.readFileSync(target, "utf8");
    assert.equal(written.includes(start), false);
    assert.equal(written.includes(end), false);
    assert.equal(bundles.subscriptionPatched(written), true);
  });

  it("reports no hook on a clean bundle", () => {
    const target = path.join(tmpRoot, "clean.desktop.main.js");
    fs.writeFileSync(target, makeBundle());

    assert.equal(bundles.patchBundle(target).foreignHook, false);
  });
});
