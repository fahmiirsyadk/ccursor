/**
 * Blob store.
 *
 * Cursor refers to conversation content by blob id instead of inlining it. A blob is
 * base64-encoded JSON of one message, and its id is the SHA-256 of that string, so
 * the id is also the content address.
 *
 * Blobs reach us two ways:
 *
 *   UploadConversationBlobs   the client pushes id + value before a turn
 *   kvServerMessage/setBlob   we push content to the client
 *
 * Both are kept here, in memory for speed and on disk so a restart does not lose
 * the history of a conversation that is still open.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { stateDir } from "../paths.js";

const memory = new Map();
const MAX_IN_MEMORY = 4096;

const blobDir = () => path.join(stateDir(), "blobs");

/** Blob ids are base64, which is not a safe filename. */
function fileName(id) {
  return crypto.createHash("sha256").update(id).digest("hex");
}

/**
 * Store a blob.
 *
 * @param {string} id base64 SHA-256 of the payload
 * @param {string} data base64-encoded JSON
 */
export function putBlob(id, data) {
  if (!id || typeof data !== "string") return;

  memory.set(id, data);
  if (memory.size > MAX_IN_MEMORY) {
    const oldest = memory.keys().next().value;
    memory.delete(oldest);
  }

  try {
    const dir = blobDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName(id)), data);
  } catch {
    /* the in-memory copy is enough for the current turn */
  }
}

/**
 * Look a blob up.
 *
 * @param {string} id
 * @returns {string|null} base64-encoded JSON
 */
export function getBlob(id) {
  if (!id) return null;
  const hit = memory.get(id);
  if (hit !== undefined) return hit;

  try {
    const data = fs.readFileSync(path.join(blobDir(), fileName(id)), "utf8");
    memory.set(id, data);
    return data;
  } catch {
    return null;
  }
}

/** Decode a blob into the JSON it holds. */
export function readBlobJson(id) {
  const data = getBlob(id);
  if (!data) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/** Encode a value the way Cursor does, returning both id and payload. */
export function makeBlob(value) {
  const data = Buffer.from(JSON.stringify(value), "utf8").toString("base64");
  const id = crypto.createHash("sha256").update(data).digest("base64");
  putBlob(id, data);
  return { id, data };
}

/** Forget everything held in memory; used by tests. */
export function clearBlobs() {
  memory.clear();
}
