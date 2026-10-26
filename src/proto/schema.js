/**
 * Schema loading.
 *
 * Cursor ships its protobuf schemas as FileDescriptorProto blobs inside the BYOK
 * extension bundle, including the google.protobuf types it uses. protobufjs turns
 * them into a Root with full encode/decode support, so there is no codec and no
 * descriptor parser to maintain here — only the scan that finds the blobs.
 *
 * The descriptors are cached by `apply` (see proto/cache.js), so the server can
 * start without the extension bundle being present. When the bundle is newer than
 * the cache, the bundle wins: a Cursor update may have changed the protocol.
 */

import fs from "node:fs";
import protobuf from "protobufjs";
import "protobufjs/ext/descriptor.js";

import * as schemaCache from "./cache.js";
import { readClientSchema } from "./client-schema.js";

const cache = new Map();

/**
 * The bundle embeds timestamp, duration, any and struct, but not Empty, which a
 * few messages reference. Declared here exactly as specified: no fields.
 */
function emptyDescriptor() {
  const { FileDescriptorProto } = protobuf.descriptor;
  return FileDescriptorProto.encode({
    name: "google/protobuf/empty.proto",
    package: "google.protobuf",
    syntax: "proto3",
    messageType: [{ name: "Empty" }],
  }).finish();
}

/** varint-encode a length for a length-delimited field. */
function varintBytes(value) {
  const out = [];
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

/** Wrap FileDescriptorProto buffers into a FileDescriptorSet. */
function toDescriptorSet(buffers) {
  const parts = [];
  for (const raw of buffers) {
    parts.push(Buffer.from([0x0a, ...varintBytes(raw.length)]), raw);
  }
  return Buffer.concat(parts);
}

/**
 * Build a Root from the cached schema, falling back to the files it came from.
 *
 * The client's schema is preferred: it is generated from the protocol Cursor speaks
 * today, while the extension's copy is a separate and older artifact. See
 * proto/cache.js.
 *
 * @param {object} [sources]
 * @param {string} [sources.workbench] path to workbench.desktop.main.js
 * @param {string} [sources.extension] path to the BYOK extension bundle
 * @returns {import("protobufjs").Root}
 */
export function loadRoot({ workbench, extension } = {}) {
  const key = `${workbench ?? ""}|${extension ?? ""}`;
  if (cache.has(key)) return cache.get(key);

  const root = build({ workbench, extension });
  cache.set(key, root);
  return root;
}

function build({ workbench }) {
  // 1. The cache, when it still matches the bundle it was built from.
  const cached = schemaCache.load();
  if (cached && (!workbench || schemaCache.isFreshFor(workbench))) {
    const root = protobuf.Root.fromJSON(cached);
    addEmptyIfMissing(root);
    return root;
  }

  // 2. The client bundle itself.
  if (workbench && fs.existsSync(workbench)) {
    const { json } = readClientSchema(workbench);
    const root = protobuf.Root.fromJSON(json);
    addEmptyIfMissing(root);
    return root;
  }

  throw new Error(
    "no protobuf schema available: run 'cursor-byok apply' to cache it from Cursor's client",
  );
}

function fromDescriptors(raws) {
  return protobuf.Root.fromDescriptor(toDescriptorSet(raws), { keepCase: true });
}

/**
 * `google.protobuf.Empty` is used by a few messages but is not among the generated
 * types in either bundle. Declared here: no fields.
 */
function addEmptyIfMissing(root) {
  try {
    root.lookupType("google.protobuf.Empty");
    return;
  } catch {
    /* not present, add it */
  }
  try {
    root.addJSON({
      nested: { google: { nested: { protobuf: { nested: { Empty: { fields: {} } } } } } },
    });
    root.resolveAll();
  } catch {
    /* a schema that already resolves does not need this */
  }
}

/** Look up a message type, with a clear error when the schema changed. */
export function lookupType(root, name) {
  try {
    return root.lookupType(name);
  } catch (error) {
    throw new Error(`schema type not found: ${name} (${error.message})`);
  }
}

/** Clear the cache; used by tests. */
export function clearCache() {
  cache.clear();
}
