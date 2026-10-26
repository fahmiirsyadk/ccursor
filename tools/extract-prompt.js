#!/usr/bin/env node
/**
 * Write Cursor's agent prompt to a file, for inspection.
 *
 * `cursor-byok apply` does this as part of patching; this tool is the same thing
 * without touching the install, so the text can be read, diffed across Cursor
 * releases, or checked when a turn behaves oddly.
 *
 * Usage:
 *   node tools/extract-prompt.js               write to the state directory
 *   node tools/extract-prompt.js --print       also print it
 *   node tools/extract-prompt.js --out FILE    write it somewhere else
 *   node tools/extract-prompt.js --app DIR     read a specific Cursor install
 */

import fs from "node:fs";
import path from "node:path";

import { discover } from "../src/locate.js";
import { stateDir } from "../src/paths.js";
import { extractBasePrompt } from "../src/prompt/base.js";

function arg(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : undefined;
}

const has = (name) => process.argv.includes(`--${name}`);

const appRoot = arg("app") ?? discover().appRoot;
if (!appRoot) {
  console.error("Cursor not found; pass --app <resources/app>");
  process.exit(1);
}

let prompt;
try {
  prompt = extractBasePrompt(appRoot);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const out = arg("out") ?? path.join(stateDir(), "prompt.txt");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${prompt}\n`);

console.log(`prompt: ${prompt.length} chars, ${prompt.split("\n").length} lines -> ${out}`);

if (has("print")) console.log(`\n${prompt}`);
