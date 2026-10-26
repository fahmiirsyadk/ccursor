/**
 * Parser for Cursor's bundled protobuf descriptor.
 *
 * Cursor's BYOK extension embeds the `agent.v1` schema as a base64-encoded
 * FileDescriptorProto. That is interface data — message names, field numbers and
 * types — the same structure `protoc --decode` consumes. We read it from the
 * installed app at runtime instead of redistributing it, so the schema always
 * matches the Cursor version on disk.
 */

import fs from "node:fs";

// ---------------------------------------------------------------- wire reading

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
  }
}

/** Yield [fieldNumber, wireType, value] for one message buffer. */
function* fields(buf) {
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const number = tag >> 3;
    const wire = tag & 7;

    if (wire === 0) {
      let value;
      [value, pos] = readVarint(buf, pos);
      yield [number, wire, value];
    } else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      yield [number, wire, buf.subarray(pos, pos + len)];
      pos += len;
    } else if (wire === 5) {
      yield [number, wire, buf.subarray(pos, pos + 4)];
      pos += 4;
    } else if (wire === 1) {
      yield [number, wire, buf.subarray(pos, pos + 8)];
      pos += 8;
    } else {
      throw new Error(`unsupported wire type ${wire} at ${pos}`);
    }
  }
}

const utf8 = (buf) => buf.toString("utf8");

// ------------------------------------------------------------- proto constants

const SCALAR = {
  1: "double", 2: "float", 3: "int64", 4: "uint64", 5: "int32",
  6: "fixed64", 7: "fixed32", 8: "bool", 9: "string", 12: "bytes",
  13: "uint32", 15: "sfixed32", 16: "sfixed64", 17: "sint32", 18: "sint64",
};
const LABEL_REPEATED = 3;

// ---------------------------------------------------------------- descriptor

function parseField(buf) {
  const f = { name: null, number: null, label: 1, type: null, typeName: null, oneof: null };
  for (const [n, w, v] of fields(buf)) {
    if (n === 1) f.name = utf8(v);
    else if (n === 3) f.number = v;
    else if (n === 4) f.label = v;
    else if (n === 5) f.type = v;
    else if (n === 6) f.typeName = utf8(v);
    else if (n === 9) f.oneof = v;
  }
  return f;
}

function parseEnum(buf) {
  const e = { name: null, values: [] };
  for (const [n, w, v] of fields(buf)) {
    if (n === 1) e.name = utf8(v);
    else if (n === 2) {
      let vname = null, vnum = null;
      for (const [n2, w2, v2] of fields(v)) {
        if (n2 === 1) vname = utf8(v2);
        else if (n2 === 2) vnum = v2;
      }
      e.values.push({ name: vname, number: vnum });
    }
  }
  return e;
}

function parseMessage(buf, parentPrefix = "") {
  const m = { name: null, fields: [], nested: [], enums: [], oneofs: [] };
  for (const [n, w, v] of fields(buf)) {
    if (n === 1) m.name = utf8(v);
    else if (n === 2) m.fields.push(parseField(v));
    else if (n === 3) m.nested.push(parseMessage(v, `${parentPrefix}${m.name}.`));
    else if (n === 4) m.enums.push(parseEnum(v));
    else if (n === 8) {
      let name = null;
      for (const [n2, w2, v2] of fields(v)) if (n2 === 1) name = utf8(v2);
      m.oneofs.push(name);
    }
  }
  return m;
}

function parseFile(buf) {
  const file = { name: null, package: null, messages: [], enums: [], services: [] };
  for (const [n, w, v] of fields(buf)) {
    if (n === 1) file.name = utf8(v);
    else if (n === 2) file.package = utf8(v);
    else if (n === 4) file.messages.push(parseMessage(v));
    else if (n === 5) file.enums.push(parseEnum(v));
    else if (n === 6) {
      let sname = null;
      const methods = [];
      for (const [n2, w2, v2] of fields(v)) {
        if (n2 === 1) sname = utf8(v2);
        else if (n2 === 2) {
          const m = {};
          for (const [n3, w3, v3] of fields(v2)) {
            if (n3 === 1) m.name = utf8(v3);
            else if (n3 === 2) m.input = utf8(v3);
            else if (n3 === 3) m.output = utf8(v3);
            else if (n3 === 4) m.serverStreaming = true;
            else if (n3 === 5) m.clientStreaming = true;
          }
          methods.push(m);
        }
      }
      file.services.push({ name: sname, methods });
    }
  }
  return file;
}


/** Pull the longest base64 literal that precedes a given marker. */
export function findDescriptor(source, marker = "var ob=Fe(qe,12)") {
  const at = source.indexOf(marker);
  if (at < 0) throw new Error(`descriptor marker not found: ${marker}`);
  const end = source.lastIndexOf('"', at);
  const start = source.lastIndexOf('"', end - 1);
  const b64 = source.slice(start + 1, end);
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

/**
 * Flatten a parsed file into a lookup table of fully-qualified message names.
 * Nested messages are hoisted so callers can address them by their proto name.
 */
function buildTable(file) {
  const table = {};
  const walk = (msg, prefix) => {
    const full = `${prefix}${msg.name}`;
    table[full] = {
      fields: msg.fields.map((f) => ({
        name: f.name,
        number: f.number,
        repeated: f.label === LABEL_REPEATED,
        type: f.type === 11 || f.type === 10 ? f.typeName : SCALAR[f.type] ?? `#${f.type}`,
        ...(f.oneof !== null ? { oneof: msg.oneofs[f.oneof] } : {}),
      })),
      enums: Object.fromEntries(msg.enums.map((e) => [e.name, e.values])),
    };
    for (const nested of msg.nested) walk(nested, `${full}.`);
  };
  for (const msg of file.messages) walk(msg, `${file.package}.`);
  return table;
}

/** Parse a FileDescriptorProto buffer into a flat message lookup table. */
export function parseDescriptor(raw) {
  const file = parseFile(raw);
  return { file, table: buildTable(file) };
}

/** Read and parse a descriptor straight from an extension bundle. */
export function readSchema(extensionJsPath) {
  const source = fs.readFileSync(extensionJsPath, "utf8");
  return parseDescriptor(findDescriptor(source));
}
