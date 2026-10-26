/**
 * Byte-level patches for Cursor's workbench bundles.
 *
 * Cursor disables bring-your-own-key in two places that are independent of the
 * transport. Both are one-line guards inside the minified bundle, so the patch
 * replaces the guard with a constant and leaves everything else untouched.
 *
 * Patch 1 -- subscription listener
 *   `subscriptionChangedListener=(prev,next)=>{ ... && next===FREE && prev!==FREE
 *    && this.<setKey>(false) }`
 *
 *   When the billing profile is refreshed and reads as `free`, this callback
 *   silently switches the BYOK toggle off. The models then disappear from the
 *   picker and only Auto remains. Replacing the call with `void 0` keeps the
 *   toggle where the user put it.
 *
 * Patch 2 -- admin policy
 *   `... && <useKey> && ( log("... action=disable-openai-key ..."),
 *    storage.<set>(key, false) )`
 *
 *   This path runs when the account policy reports BYOK as disabled. Replacing
 *   the whole expression with `&& !1` prevents the reset.
 *
 * Both patches are structural: they anchor on stable surrounding text, validate
 * the span they are about to rewrite, and refuse to touch anything that does not
 * match the expected shape. That is what makes them survive Cursor point
 * releases instead of relying on brittle exact-string matches.
 */

import fs from "node:fs";
import path from "node:path";

import { BUNDLES } from "./paths.js";

// --- patch 1 anchors -------------------------------------------------------

const SUB_ANCHOR = "subscriptionChangedListener=";
const SUB_TAIL = "(!1)}";
const SUB_SEARCH_WINDOW = 500;
const SUB_MAX_CALL_LEN = 60;

// --- patch 2 anchors -------------------------------------------------------

const ADMIN_MARK = "action=disable-openai-key";
const ADMIN_HEAD = "&&i.use";
const ADMIN_TAIL = ",!1))";
const ADMIN_PROOF = "setApplicationUserPersistentStorage";

const PATCHED_SUB = "&&void 0}";
const PATCHED_ADMIN = "&&!1";

export class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "PatchError";
  }
}

/** Existing workbench bundles for this install, in a stable order. */
export function bundlePaths(appRoot) {
  const found = [];
  for (const name of BUNDLES) {
    const file = path.join(appRoot, "out", "vs", "workbench", name);
    if (fs.existsSync(file)) found.push(file);
  }
  return found;
}

export function subscriptionPatched(data) {
  const text = toText(data);
  const idx = text.indexOf(SUB_ANCHOR);
  if (idx < 0) return false;
  return text.slice(idx, idx + SUB_SEARCH_WINDOW).includes(PATCHED_SUB);
}

export function adminPolicyPatched(data) {
  return !toText(data).includes(ADMIN_MARK);
}

/**
 * Neutralise the downgrade callback.
 * @returns {[Buffer, "patched"|"already"|"not-found"]}
 */
export function patchSubscription(input) {
  const text = toText(input);
  const idx = text.indexOf(SUB_ANCHOR);
  if (idx < 0) return [input, "not-found"];

  const window = text.slice(idx, idx + SUB_SEARCH_WINDOW);
  if (window.includes(PATCHED_SUB)) return [input, "already"];

  const tailAt = window.indexOf(SUB_TAIL);
  if (tailAt < 0) return [input, "not-found"];

  // Nearest `&&` before the closing token, then bound the span so a wide search
  // cannot swallow an unrelated expression.
  const headAt = window.lastIndexOf("&&", tailAt);
  if (headAt < 0 || tailAt - headAt > 80) return [input, "not-found"];

  const call = window.slice(headAt + 2, tailAt);
  if (call.length > SUB_MAX_CALL_LEN || call.includes("&&") || call.includes("(")) {
    return [input, "not-found"];
  }

  const start = idx + headAt;
  const end = idx + tailAt + SUB_TAIL.length;
  return [text.slice(0, start) + PATCHED_SUB + text.slice(end), "patched"];
}

/**
 * Neutralise the policy-driven reset.
 * @returns {[Buffer, "patched"|"already"|"not-found"]}
 */
export function patchAdminPolicy(input) {
  const text = toText(input);
  const markAt = text.indexOf(ADMIN_MARK);
  if (markAt < 0) return [input, "already"];

  const head = text.lastIndexOf(ADMIN_HEAD, markAt);
  if (head < 0) return [input, "not-found"];

  const tail = text.indexOf(ADMIN_TAIL, markAt);
  if (tail < 0) return [input, "not-found"];

  const end = tail + ADMIN_TAIL.length;
  if (!text.slice(head, end).includes(ADMIN_PROOF)) return [input, "not-found"];

  return [text.slice(0, head) + PATCHED_ADMIN + text.slice(end), "patched"];
}

/**
 * Apply both patches to one bundle, writing only when something changed.
 *
 * @returns {{path: string, subscription: string, adminPolicy: string, changed: boolean}}
 */
export function patchBundle(file) {
  const data = fs.readFileSync(file, "utf8");

  let patched;
  let subState;
  [patched, subState] = patchSubscription(data);

  if (subState === "not-found") {
    throw new PatchError(
      `${path.basename(file)}: could not find the subscription downgrade callback. ` +
        "This Cursor build may have moved the guard; run 'cursor-byok doctor'.",
    );
  }

  let adminState;
  [patched, adminState] = patchAdminPolicy(patched);

  if (adminState === "not-found") {
    throw new PatchError(
      `${path.basename(file)}: found the admin policy marker but could not isolate ` +
        "the reset expression. Run 'cursor-byok doctor' before retrying.",
    );
  }

  const changed = patched !== data;
  if (changed) fs.writeFileSync(file, patched);

  return {
    path: file,
    subscription: subState,
    adminPolicy: adminState,
    changed,
  };
}

/** Bundles are latin1-safe: treat bytes as text without re-encoding surprises. */
function toText(input) {
  return typeof input === "string" ? input : input.toString("latin1");
}
