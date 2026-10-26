#!/usr/bin/env node
/**
 * Dump the protobuf schema Cursor's own client carries.
 *
 * The client's generated code is the schema it encodes and decodes with, so this
 * reads it straight out of the workbench bundle. Nothing is vendored and nothing
 * comes from a third-party extension, so the output always matches the Cursor
 * version on disk.
 *
 * Usage:
 *   node tools/extract-schema.js                     list namespaces and services
 *   node tools/extract-schema.js --message AgentRunRequest
 *   node tools/extract-schema.js --out schema.json
 */

import fs from "node:fs";
import path from "node:path";
import protobuf from "protobufjs";

import { discover } from "../src/locate.js";
import { readClientSchema } from "../src/proto/client-schema.js";

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

const appRoot = arg("app") ?? discover().appRoot;
if (!appRoot) {
  console.error("Cursor not found; pass --app <resources/app>");
  process.exit(1);
}

const workbench = path.join(appRoot, "out/vs/workbench/workbench.desktop.main.js");
if (!fs.existsSync(workbench)) {
  console.error(`Cursor's client bundle not found at ${workbench}`);
  process.exit(1);
}

const { json, stats } = readClientSchema(workbench);

const only = arg("message");
if (only) {
  const root = protobuf.Root.fromJSON(json);
  const names = [];
  const walk = (namespace) => {
    for (const nested of namespace.nestedArray ?? []) {
      if (nested.fields) names.push(nested.fullName.replace(/^\./, ""));
      walk(nested);
    }
  };
  walk(root);

  const name = only.includes(".")
    ? only
    : names.find((full) => full.split(".").pop() === only);

  if (!name) {
    console.error(`message not found: ${only}`);
    process.exit(1);
  }

  const type = root.lookupType(name);
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
  fs.writeFileSync(out, `${JSON.stringify(json)}\n`);
  console.log(`wrote ${out}`);
}

for (const [pkg, namespace] of Object.entries(json.nested ?? {})) {
  const services = Object.values(namespace.nested ?? {}).filter((entry) => entry.methods);
  console.log(`${pkg.padEnd(12)} ${String(services.length).padStart(3)} services`);
}

console.log(
  `${stats.messages} messages, ${stats.enums} enums, ${stats.services} services, ` +
    `${stats.methods} methods`,
);
