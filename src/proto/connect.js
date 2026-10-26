/**
 * ConnectRPC framing.
 *
 * Cursor talks to its backend with the Connect protocol, via @connectrpc/connect-web
 * and @bufbuild/protobuf. Two shapes:
 *
 * Unary
 *   POST /pkg.Service/Method
 *   content-type: application/proto
 *   body: the message bytes, possibly compressed (connect-content-encoding: gzip)
 *   response: the message bytes, no envelope
 *
 * Streaming (server-stream, bidi)
 *   Request and response are both a sequence of envelopes:
 *     byte 0      flags: 0x01 compressed, 0x02 end-of-stream, else data
 *     bytes 1..4  payload length, big-endian uint32
 *   The end-of-stream frame carries a JSON trailer in its payload.
 *
 * Verified against a live install: an empty AvailableModels request returns bare
 * protobuf, RunSSE streams envelopes, and Cursor's client gzips unary requests.
 */

import zlib from "node:zlib";

export const FLAG_DATA = 0x00;
export const FLAG_COMPRESSED = 0x01;
export const FLAG_END = 0x02;
export const ENVELOPE_BYTES = 5;

/** Wrap one message in a stream envelope. */
export function frame(payload, flags = FLAG_DATA) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(ENVELOPE_BYTES);
  header[0] = flags;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}

/** The end-of-stream frame, optionally carrying a JSON trailer. */
export function endFrame(trailer = {}) {
  return frame(Buffer.from(JSON.stringify(trailer), "utf8"), FLAG_END);
}

/**
 * Incremental envelope reader.
 *
 * Feed it chunks as they arrive; it yields complete messages and keeps the
 * remainder buffered. A stream frame can be split across TCP packets, so callers
 * must not assume one chunk equals one message.
 */
export class FrameReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  /** @returns {{flags: number, payload: Buffer}[]} complete frames */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out = [];

    while (this.buffer.length >= ENVELOPE_BYTES) {
      const flags = this.buffer[0];
      const length = this.buffer.readUInt32BE(1);
      if (this.buffer.length < ENVELOPE_BYTES + length) break;
      const payload = this.buffer.subarray(ENVELOPE_BYTES, ENVELOPE_BYTES + length);
      out.push({ flags, payload });
      this.buffer = this.buffer.subarray(ENVELOPE_BYTES + length);
    }

    return out;
  }

  /** Bytes left over that did not form a complete frame. */
  get remainder() {
    return this.buffer;
  }
}

/** Compression Cursor may apply, keyed by the encoding name it announces. */
const DECODERS = {
  gzip: (data) => zlib.gunzipSync(data),
  deflate: (data) => zlib.inflateSync(data),
  br: (data) => zlib.brotliDecompressSync(data),
};

/** Decompress a body if the request says it is compressed. */
export function decompress(body, encoding) {
  if (!encoding) return body;
  const name = String(encoding).trim().toLowerCase();
  if (name === "" || name === "identity") return body;
  const decode = DECODERS[name];
  if (!decode) throw new Error(`unsupported content-encoding: ${encoding}`);
  return decode(body);
}

/**
 * The encoding a Connect request used.
 *
 * `connect-content-encoding` is the protocol header; `content-encoding` is what
 * plain HTTP would use. Either may appear.
 */
export function requestEncoding(headers = {}) {
  return headers["connect-content-encoding"] ?? headers["content-encoding"] ?? "";
}

/**
 * Unwrap a streaming request body into its messages.
 *
 * The client frames these even for a request that carries a single message, and may
 * compress each frame individually. A body that is not framed at all is accepted as
 * one message, because that is what a hand-written client sends.
 */
export function readStreamRequest(body, encoding) {
  if (body.length === 0) return [];

  const looksFramed = (buf) =>
    buf.length >= ENVELOPE_BYTES &&
    (buf[0] === FLAG_DATA || buf[0] === FLAG_COMPRESSED || buf[0] === FLAG_END);

  // A client may compress the whole body before framing it, or leave it unframed.
  let buffer = body;
  if (!looksFramed(buffer) && encoding) buffer = decompress(buffer, encoding);
  if (!looksFramed(buffer)) return [buffer];

  const reader = new FrameReader();
  const messages = [];
  for (const item of reader.push(buffer)) {
    if (item.flags & FLAG_END) continue;
    messages.push(item.flags & FLAG_COMPRESSED ? decompress(item.payload, encoding || "gzip") : item.payload);
  }
  return messages;
}

/** Path helpers: "/aiserver.v1.AiService/AvailableModels" -> parts. */
export function parseRpcPath(pathname) {
  const match = /^\/([A-Za-z0-9_.]+)\/([A-Za-z0-9_]+)$/.exec(pathname);
  if (!match) return null;
  return { service: match[1], method: match[2] };
}

/** Connect error body. */
export function errorBody(code, message) {
  return Buffer.from(JSON.stringify({ code, message }), "utf8");
}
