/**
 * Protobuf codec behaviour.
 *
 * The encoder and decoder are written from the wire-format spec, so these tests use
 * hand-built byte sequences from that spec rather than round-tripping only against
 * ourselves — a codec that is wrong in the same way in both directions would pass a
 * pure round-trip test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WIRE, decode, decodeRaw, dump, encode, readVarint, writeVarint } from "../src/proto/codec.js";

const hex = (buf) => Buffer.from(buf).toString("hex");

describe("varint", () => {
  it("matches the spec examples", () => {
    // field 1, varint, value 150 -> 08 96 01
    const out = [];
    writeVarint(1 * 8 + WIRE.VARINT, out);
    writeVarint(150, out);
    assert.equal(hex(out), "089601");
  });

  it("round-trips boundary values", () => {
    for (const value of [0, 1, 127, 128, 300, 16383, 16384, 2097151]) {
      const out = [];
      writeVarint(value, out);
      const [decoded, pos] = readVarint(Buffer.from(out), 0);
      assert.equal(decoded, value);
      assert.equal(pos, out.length);
    }
  });

  it("rejects a truncated varint", () => {
    assert.throws(() => readVarint(Buffer.from([0x80]), 0), RangeError);
  });
});

describe("decodeRaw", () => {
  it("decodes a known byte sequence", () => {
    // 08 96 01       field 1, varint 150
    // 12 03 61 62 63 field 2, len 3, "abc"
    const buf = Buffer.from("0896011203616263", "hex");
    const raw = decodeRaw(buf);

    assert.equal(raw[1], 150);
    assert.deepEqual(raw[2], [Buffer.from("abc")]);
  });

  it("collects repeated length-delimited fields", () => {
    // field 1 twice, each "a" then "b"
    const buf = Buffer.from("0a01610a0162", "hex");
    const raw = decodeRaw(buf);

    assert.equal(raw[1].length, 2);
    assert.equal(raw[1][0].toString(), "a");
    assert.equal(raw[1][1].toString(), "b");
  });

  it("rejects an unsupported wire type", () => {
    // field 1, wire type 3 (start group, deprecated)
    const buf = Buffer.from([0x0b]);
    assert.throws(() => decodeRaw(buf), RangeError);
  });
});

describe("encode / decode with a schema", () => {
  const schema = [
    { name: "conversation_id", number: 5, repeated: false, type: "string" },
    { name: "exclude_workspace_context", number: 12, repeated: false, type: "bool" },
    { name: "root_prompt_messages_json", number: 1, repeated: true, type: "bytes" },
    { name: "selected_subagent_models", number: 14, repeated: true, type: "bytes" },
  ];

  it("encodes scalars with the right wire types", () => {
    const buf = encode(schema, {
      conversation_id: "abc",
      exclude_workspace_context: true,
    });

    // 2a = field 5 LEN, 03 = len, "abc"; 60 = field 12 VARINT, 01 = true
    assert.equal(hex(buf), "2a03616263" + "6001");
  });

  it("round-trips through decode", () => {
    const original = {
      conversation_id: "conv-1",
      exclude_workspace_context: false,
      root_prompt_messages_json: [Buffer.from('{"a":1}'), Buffer.from('{"b":2}')],
    };

    const decoded = decode(schema, encode(schema, original));

    assert.equal(decoded.conversation_id, "conv-1");
    assert.equal(decoded.exclude_workspace_context, false);
    assert.equal(decoded.root_prompt_messages_json.length, 2);
    assert.equal(decoded.root_prompt_messages_json[0].toString(), '{"a":1}');
  });

  it("omits absent fields", () => {
    const buf = encode(schema, { conversation_id: "x" });
    const decoded = decode(schema, buf);

    assert.equal("exclude_workspace_context" in decoded, false);
    assert.equal("root_prompt_messages_json" in decoded, false);
  });

  it("skips fields the schema does not describe", () => {
    // field 99, varint 7 — unknown to the schema
    const out = [];
    writeVarint(99 * 8 + WIRE.VARINT, out);
    writeVarint(7, out);
    const buf = Buffer.concat([Buffer.from(out), encode(schema, { conversation_id: "y" })]);

    const decoded = decode(schema, buf);

    assert.equal(decoded.conversation_id, "y");
    assert.equal(Object.keys(decoded).length, 1);
  });
});

describe("dump", () => {
  it("renders printable strings and nested messages", () => {
    const inner = encode([{ name: "id", number: 1, repeated: false, type: "string" }], { id: "abc" });
    const outer = encode(
      [
        { name: "nested", number: 1, repeated: false, type: "bytes" },
        { name: "label", number: 2, repeated: false, type: "string" },
      ],
      { nested: inner, label: "hello world" },
    );

    const lines = dump(outer).join("\n");

    assert.match(lines, /1: \{/);
    assert.match(lines, /id: "abc"|1: "abc"/);
    assert.match(lines, /hello world/);
  });
});
