/**
 * Cursor verifies the hash of its own bundled extensions before loading them.
 *
 * Two of those files carry our router, so their hashes no longer match. The obvious
 * fix — replacing the check with `if (!1)` — also stops verifying every *other*
 * extension in the list, which is a real loss: it is the mechanism that would catch
 * a tampered bundle.
 *
 * This does the narrow thing instead. Cursor's expected-hash table is a plain object
 * literal in `extensionHostProcess.js`; the two extensions we modify are removed
 * from it and the check is left exactly as Cursor wrote it. Everything else stays
 * verified.
 *
 * Verified against Cursor 3.27.12:
 *   `_verifyExtensionFiles` returns `{valid, error}`, so the check reads
 *   `if (!m.valid) throw ...`. Sixteen extensions are listed; only
 *   `anysphere.cursor-always-local` needs to be dropped, because
 *   `anysphere.cursor-agent-host` is not in the table.
 */

import fs from "node:fs";
import path from "node:path";

import { EXEMPT_EXTENSIONS } from "./paths.js";

/** Where the check lives, relative to the app root. */
export const HOST_PROCESS = "out/vs/workbench/api/node/extensionHostProcess.js";

/** Start of the expected-hash table. */
const TABLE_START = "var i_e={";

/** The check as an installer that patches broadly leaves it. */
const DISABLED = "if(!1)throw this._logService.error(`Extension verification failed";

/** The check as Cursor ships it. */
const ENABLED = "if(!m.valid)throw this._logService.error(`Extension verification failed";

export function hostProcessPath(appRoot) {
  return path.join(appRoot, HOST_PROCESS);
}

/** Index of the brace that closes the one at `open`. */
function matchBrace(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** One entry of the table: "name":{dist:{...}}, — only one level of nesting. */
function entryPattern(name) {
  return new RegExp(`"${name.replace(/\./g, "\\.")}":\\{dist:\\{[^}]*\\}\\},?`);
}

/** Names currently listed in the expected-hash table. */
export function listedExtensions(appRoot) {
  const file = hostProcessPath(appRoot);
  if (!fs.existsSync(file)) return [];

  const source = fs.readFileSync(file, "utf8");
  const start = source.indexOf(TABLE_START);
  if (start < 0) return [];

  const end = matchBrace(source, source.indexOf("{", start));
  const table = source.slice(start, end + 1);
  return [...table.matchAll(/"([\w.-]+)":\{dist:/g)].map((match) => match[1]);
}

/**
 * What state the verification check is in.
 *
 * @returns {{table: boolean, disabled: boolean, verified: number, exempt: string[]}}
 */
export function describe(appRoot) {
  const file = hostProcessPath(appRoot);
  if (!fs.existsSync(file)) return { table: false, disabled: false, verified: 0, exempt: [] };

  const source = fs.readFileSync(file, "utf8");
  const listed = listedExtensions(appRoot);
  if (listed.length === 0) return { table: false, disabled: false, verified: 0, exempt: [] };

  return {
    table: true,
    disabled: source.includes(DISABLED),
    verified: listed.length,
    exempt: EXEMPT_EXTENSIONS.filter((name) => !listed.includes(name)),
  };
}

/**
 * Exempt the extensions we modify, and restore the check for everything else.
 *
 * Idempotent: a second run changes nothing.
 *
 * @returns {{changed: boolean, exempted: string[], restored: boolean}}
 */
export function patchVerification(appRoot) {
  const file = hostProcessPath(appRoot);
  const original = fs.readFileSync(file, "utf8");
  let source = original;
  const exempted = [];

  const start = source.indexOf(TABLE_START);
  if (start < 0) throw new Error("expected-hash table not found; Cursor changed shape");

  const end = matchBrace(source, source.indexOf("{", start));
  if (end < 0) throw new Error("expected-hash table is not closed; refusing to write");

  let table = source.slice(start, end + 1);
  for (const name of EXEMPT_EXTENSIONS) {
    const pattern = entryPattern(name);
    if (!pattern.test(table)) continue;
    table = table.replace(pattern, "");
    exempted.push(name);
  }

  if (exempted.length > 0) source = source.slice(0, start) + table + source.slice(end + 1);

  // With the entries gone the broad bypass is no longer needed, so the remaining
  // extensions are verified again.
  const restored = source.includes(DISABLED);
  if (restored) source = source.split(DISABLED).join(ENABLED);

  if (source !== original) fs.writeFileSync(file, source);
  return { changed: source !== original, exempted, restored };
}
