/**
 * Locate the protobuf schemas Cursor ships inside its BYOK extension bundle.
 *
 * The bundle carries several base64-encoded FileDescriptorProto blobs. protobufjs
 * decodes them, so no descriptor parser is maintained here — only the scan that
 * finds the literals.
 */

import fs from "node:fs";
import protobuf from "protobufjs";
import "protobufjs/ext/descriptor.js";

/** Packages Cursor uses for the agent protocol. */
export const AGENT_PACKAGE = "agent.v1";
export const API_PACKAGE = "aiserver.v1";

const { FileDescriptorProto } = protobuf.descriptor;

/**
 * Every descriptor embedded in a bundle.
 *
 * Scans for long base64 literals and keeps the ones that decode as a
 * FileDescriptorProto. Anchoring on structure rather than a minified variable name
 * keeps this working across builds.
 *
 * @returns {{offset: number, raw: Buffer, file: object}[]}
 */
export function findDescriptors(source, { minBytes = 200 } = {}) {
  const found = [];
  const seen = new Set();
  const re = /"([A-Za-z0-9+/=]{200,})"/g;
  let match;

  while ((match = re.exec(source))) {
    const b64 = match[1];
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    let raw;
    try {
      raw = Buffer.from(padded, "base64");
    } catch {
      continue;
    }
    if (raw.length < minBytes) continue;

    let file;
    try {
      file = FileDescriptorProto.decode(raw);
    } catch {
      continue;
    }
    if (!file.package || !file.messageType?.length) continue;

    // The same blob can appear twice in a bundle; dedupe by name.
    const key = `${file.package}/${file.name}`;
    if (seen.has(key)) continue;
    seen.add(key);

    found.push({ offset: match.index, raw, file });
  }

  return found;
}

/** Read a bundle and return its descriptors. */
export function readDescriptors(extensionJsPath, options) {
  return findDescriptors(fs.readFileSync(extensionJsPath, "utf8"), options);
}
