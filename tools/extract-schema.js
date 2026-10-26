#!/usr/bin/env node
/**
 * Dump the protobuf schema Cursor ships inside its BYOK extension.
 *
 * Reads the descriptor from an installed app (or a given extension.js), so nothing
 * is redistributed: the schema always matches the Cursor version on disk.
 *
 * Usage:
 *   node tools/extract-schema.js [--app <resources/app>] [--out <file>] [--message <name>]
 */

import fs from "node:fs";
import path from "node:path";

import { discover } from "../src/locate.js";
import { readSchema } from "../src/proto/descriptor.js";

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

const appRoot = arg("app") ?? discover().appRoot;
if (!appRoot) {
  console.error("Cursor not found; pass --app <resources/app>");
  process.exit(1);
}

const extensionJs = path.join(appRoot, "extensions", "cursor2plus", "dist", "extension.js");
if (!fs.existsSync(extensionJs)) {
  console.error(`BYOK extension not installed at ${extensionJs}`);
  console.error("Run 'cursor-byok apply' first, or pass --app.");
  process.exit(1);
}

const { file, table } = readSchema(extensionJs);
const names = Object.keys(table);

const only = arg("message");
if (only) {
  const key = only.includes(".") ? only : `${file.package}.${only}`;
  if (!table[key]) {
    console.error(`message not found: ${key}`);
    process.exit(1);
  }
  console.log(`message ${key}`);
  for (const f of table[key].fields) {
    const type = f.type.split(".").pop();
    console.log(`  ${String(f.number).padStart(4)}  ${f.name.padEnd(38)} ${type}${f.repeated ? "[]" : ""}`);
  }
  process.exit(0);
}

const out = arg("out");
if (out) {
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        source: {
          file: file.name,
          package: file.package,
          messages: names.length,
          services: file.services.map((s) => ({
            name: s.name,
            methods: s.methods.map(
              (m) => `${m.name}(${m.input})${m.serverStreaming ? " -> stream" : ""}`,
            ),
          })),
        },
        messages: table,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`wrote ${out}`);
}

console.log(`${file.name}: ${names.length} messages, ${file.services.length} services`);
for (const s of file.services) {
  console.log(`  ${s.name}: ${s.methods.map((m) => m.name).join(", ")}`);
}
