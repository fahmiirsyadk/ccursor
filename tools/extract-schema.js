#!/usr/bin/env node
/**
 * Dump the protobuf schemas Cursor ships inside its BYOK extension.
 *
 * The schemas are read from the installed app, so nothing is vendored here and the
 * output always matches the Cursor version on disk.
 *
 * Usage:
 *   node tools/extract-schema.js                     list files and services
 *   node tools/extract-schema.js --message AgentRunRequest
 *   node tools/extract-schema.js --out schema.json
 */

import fs from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";

import { discover } from "../src/locate.js";
import { readDescriptors } from "../src/proto/descriptor.js";
import { loadRoot, lookupType } from "../src/proto/schema.js";

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

const descriptors = readDescriptors(extensionJs);

const only = arg("message");
if (only) {
  const root = loadRoot(extensionJs);

  // Collect every fully-qualified type name, then match on the last segment.
  const allTypes = [];
  const walk = (namespace) => {
    for (const nested of namespace.nestedArray ?? []) {
      if (nested instanceof protobuf.Type) allTypes.push(nested.fullName.slice(1));
      walk(nested);
    }
  };
  walk(root);

  const name = only.includes(".")
    ? only
    : allTypes.find((full) => full.split(".").pop() === only);

  if (!name) {
    console.error(`message not found: ${only}`);
    process.exit(1);
  }

  const type = lookupType(root, name);
  console.log(`message ${name}`);
  for (const [fieldName, field] of Object.entries(type.fields)) {
    const kind = field.resolvedType ? field.resolvedType.name : field.type;
    console.log(
      `  ${String(field.id).padStart(4)}  ${fieldName.padEnd(38)} ${kind}${field.repeated ? "[]" : ""}`,
    );
  }
  process.exit(0);
}

const out = arg("out");
if (out) {
  const root = loadRoot(extensionJs);
  const json = root.toJSON();
  fs.writeFileSync(out, JSON.stringify(json, null, 2) + "\n");
  console.log(`wrote ${out}`);
}

let totalTypes = 0;
for (const d of descriptors) {
  const types = d.file.messageType.length;
  totalTypes += types;
  const services = d.file.service?.length ?? 0;
  console.log(
    `${d.file.package.padEnd(16)} ${String(d.file.name).padEnd(30)} ${String(types).padStart(5)} top-level  ${services} services`,
  );
}
console.log(`${descriptors.length} files, ${totalTypes} top-level messages`);
