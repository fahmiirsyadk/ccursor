/**
 * Connect framing and compression.
 *
 * These pin the shapes Cursor's client actually uses, because getting them wrong
 * produces a protobuf decode error on the client rather than a clear failure here.
 */

import assert from "node:assert/strict";
import zlib from "node:zlib";
import { describe, it } from "node:test";

import {
  ENVELOPE_BYTES,
  FrameReader,
  decompress,
  endFrame,
  frame,
  parseRpcPath,
  readStreamRequest,
  requestEncoding,
} from "../src/proto/connect.js";

describe("framing", () => {
  it("writes a five-byte header and the payload", () => {
    const out = frame(Buffer.from("hi"));
    assert.equal(out.length, ENVELOPE_BYTES + 2);
    assert.equal(out[0], 0);
    assert.equal(out.readUInt32BE(1), 2);
    assert.equal(out.subarray(5).toString(), "hi");
  });

  it("marks the end of a stream and carries a trailer", () => {
    const out = endFrame({ error: { code: "internal" } });
    assert.equal(out[0], 2);
    assert.deepEqual(JSON.parse(out.subarray(5).toString()), { error: { code: "internal" } });
  });

  it("reads frames split across chunks", () => {
    const reader = new FrameReader();
    const one = frame(Buffer.from("a"));
    const two = frame(Buffer.from("bb"));

    assert.deepEqual(reader.push(one.subarray(0, 3)), []);
    const rest = reader.push(Buffer.concat([one.subarray(3), two.subarray(0, 2)]));
    assert.equal(rest.length, 1);
    assert.equal(rest[0].payload.toString(), "a");

    const last = reader.push(two.subarray(2));
    assert.equal(last.length, 1);
    assert.equal(last[0].payload.toString(), "bb");
  });

  it("parses an RPC path", () => {
    assert.deepEqual(parseRpcPath("/agent.v1.AgentService/RunSSE"), {
      service: "agent.v1.AgentService",
      method: "RunSSE",
    });
    assert.equal(parseRpcPath("/health"), null);
  });
});

describe("compression", () => {
  it("gunzips when the request says gzip", () => {
    const body = Buffer.from("payload");
    const out = decompress(zlib.gzipSync(body), "gzip");
    assert.deepEqual(out, body);
  });

  it("leaves an identity body alone", () => {
    const body = Buffer.from("payload");
    assert.deepEqual(decompress(body, ""), body);
    assert.deepEqual(decompress(body, "identity"), body);
    assert.deepEqual(decompress(body, undefined), body);
  });

  it("refuses an encoding it cannot undo", () => {
    assert.throws(() => decompress(Buffer.from("x"), "snappy"), /unsupported/);
  });

  it("prefers the Connect header, then the HTTP one", () => {
    assert.equal(requestEncoding({ "connect-content-encoding": "gzip" }), "gzip");
    assert.equal(requestEncoding({ "content-encoding": "deflate" }), "deflate");
    assert.equal(requestEncoding({}), "");
  });
});

describe("streaming request bodies", () => {
  it("unwraps a framed message", () => {
    const body = frame(Buffer.from("hello"));
    assert.deepEqual(readStreamRequest(body, ""), [Buffer.from("hello")]);
  });

  it("unwraps a frame the client compressed", () => {
    const body = frame(zlib.gzipSync(Buffer.from("hello")), 0x01);
    assert.deepEqual(readStreamRequest(body, "gzip"), [Buffer.from("hello")]);
  });

  it("accepts an unframed body as one message", () => {
    // 0x0a is a valid tag, so this cannot be mistaken for an envelope.
    const body = Buffer.from([0x0a, 0x02, 0x68, 0x69]);
    assert.deepEqual(readStreamRequest(body, ""), [body]);
  });

  it("handles an empty body", () => {
    assert.deepEqual(readStreamRequest(Buffer.alloc(0), ""), []);
  });

  it("handles a body compressed as a whole and then framed", () => {
    const body = zlib.gzipSync(frame(Buffer.from("hello")));
    assert.deepEqual(readStreamRequest(body, "gzip"), [Buffer.from("hello")]);
  });
});
