/**
 * Schema loading.
 *
 * Cursor ships its protobuf schemas as FileDescriptorProto blobs inside the BYOK
 * extension bundle, including the google.protobuf types it uses. protobufjs turns
 * them into a Root with full encode/decode support, so there is no codec and no
 * descriptor parser to maintain here — only the scan that finds the blobs.
 *
 * The schema is read from the installed app at runtime, so it always matches the
 * Cursor version on disk.
 */

import protobuf from "protobufjs";
import "protobufjs/ext/descriptor.js";

import { readDescriptors } from "./descriptor.js";

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
 * Build one Root containing every schema Cursor's bundle carries.
 *
 * @param {string} extensionJs path to the BYOK extension bundle
 * @returns {import("protobufjs").Root}
 */
export function loadRoot(extensionJs) {
  if (cache.has(extensionJs)) return cache.get(extensionJs);

  const descriptors = readDescriptors(extensionJs);
  if (descriptors.length === 0) {
    throw new Error("no protobuf descriptors found in the extension bundle");
  }

  const root = protobuf.Root.fromDescriptor(
    toDescriptorSet([...descriptors.map((d) => d.raw), emptyDescriptor()]),
    { keepCase: true },
  );

  cache.set(extensionJs, root);
  return root;
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
