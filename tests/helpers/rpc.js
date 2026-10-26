/**
 * A minimal Connect-Web client.
 *
 * Cursor's renderer uses @connectrpc/connect-web, which does two things that a
 * hand-written request does not: it gzips unary request bodies, and it frames
 * streaming request bodies in five-byte envelopes. Both are easy to get wrong on
 * the server and impossible to notice from a test that sends raw protobuf, so the
 * tests go through this instead of calling fetch directly.
 */

import zlib from "node:zlib";

import { FrameReader, frame } from "../../src/proto/connect.js";

/** Unary call: gzip the message, as connect-web does. */
export async function unary(base, route, body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const compressed = payload.length > 0 ? zlib.gzipSync(payload) : payload;

  return fetch(`${base}/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/proto",
      "connect-protocol-version": "1",
      ...(compressed.length > 0 ? { "connect-content-encoding": "gzip" } : {}),
    },
    body: compressed,
  });
}

/** Start a server-streaming call, with the request in an envelope. */
export async function stream(base, route, body) {
  return fetch(`${base}/${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/connect+proto",
      "connect-protocol-version": "1",
    },
    body: frame(body),
  });
}

/** Read every frame of a streaming response. */
export async function readStream(root, response, messageType) {
  const Type = root.lookupType(messageType);
  const reader = new FrameReader();
  const messages = [];
  let trailer = null;

  for await (const chunk of response.body) {
    for (const item of reader.push(Buffer.from(chunk))) {
      if (item.flags & 0x02) {
        trailer = item.payload.toString("utf8");
        continue;
      }
      messages.push(Type.decode(item.payload));
    }
  }

  return { messages, trailer };
}
