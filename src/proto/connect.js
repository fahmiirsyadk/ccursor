/**
 * ConnectRPC framing.
 *
 * Cursor talks to its backend with the Connect protocol, not gRPC. Two shapes:
 *
 * Unary
 *   POST /pkg.Service/Method
 *   content-type: application/proto
 *   body: the raw message bytes, no envelope
 *   response: the raw message bytes, no envelope
 *
 * Streaming (server-stream, bidi)
 *   Each message is a 5-byte envelope followed by the payload:
 *     byte 0      flags: 0x00 data, 0x02 end-of-stream
 *     bytes 1..4  payload length, big-endian uint32
 *   The end-of-stream frame carries a JSON trailer in its payload.
 *
 * Verified against a live install: an empty AvailableModels request returns 525
 * bytes of bare protobuf, and RunSSE streams envelopes.
 */

export const FLAG_DATA = 0x00;
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
