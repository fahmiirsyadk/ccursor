/**
 * Minimal protobuf wire-format codec.
 *
 * Written from the protobuf encoding specification, no dependency and no generated
 * code. It covers the subset Cursor's `agent.v1` schema uses: varints, 64-bit and
 * 32-bit fixed fields, length-delimited fields (strings, bytes, nested messages,
 * packed arrays).
 *
 * Decoding produces plain objects keyed by field number so callers can work with
 * the schema table directly; encoding takes the same shape. This keeps us free of a
 * runtime library while staying readable.
 */

export const WIRE = {
  VARINT: 0,
  I64: 1,
  LEN: 2,
  I32: 5,
};

// --------------------------------------------------------------- varint coding

export function writeVarint(value, out) {
  let v = value;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

export function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new RangeError("truncated varint");
    const byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if (!(byte & 0x80)) return [result, pos];
    shift += 7;
    if (shift > 63) throw new RangeError("varint too long");
  }
}

// ------------------------------------------------------------------- encoding

function encodeTag(number, wire, out) {
  writeVarint(number * 8 + wire, out);
}

function writeFixed64(value, out) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  out.push(...buf);
}

function writeFixed32(value, out) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(Number(value) >>> 0);
  out.push(...buf);
}

/**
 * Encode one field.
 * @param {number} number field number
 * @param {string} type scalar name from the schema, or a message name
 * @param {any} value
 * @param {boolean} repeated
 */
function encodeField(number, type, value, repeated, out) {
  const values = repeated ? (Array.isArray(value) ? value : [value]) : [value];

  for (const item of values) {
    if (item === undefined || item === null) continue;

    switch (type) {
      case "bool":
        encodeTag(number, WIRE.VARINT, out);
        writeVarint(item ? 1 : 0, out);
        break;
      case "int32":
      case "uint32":
      case "sint32":
      case "enum":
        encodeTag(number, WIRE.VARINT, out);
        writeVarint(item, out);
        break;
      case "int64":
      case "uint64":
      case "sint64":
        encodeTag(number, WIRE.VARINT, out);
        writeVarint(item, out);
        break;
      case "double":
        encodeTag(number, WIRE.I64, out);
        writeFixed64(item, out);
        break;
      case "fixed64":
      case "sfixed64":
        encodeTag(number, WIRE.I64, out);
        writeFixed64(item, out);
        break;
      case "float":
      case "fixed32":
      case "sfixed32":
        encodeTag(number, WIRE.I32, out);
        writeFixed32(item, out);
        break;
      case "string": {
        const bytes = Buffer.from(String(item), "utf8");
        encodeTag(number, WIRE.LEN, out);
        writeVarint(bytes.length, out);
        out.push(...bytes);
        break;
      }
      case "bytes": {
        const bytes = Buffer.isBuffer(item) ? item : Buffer.from(item);
        encodeTag(number, WIRE.LEN, out);
        writeVarint(bytes.length, out);
        out.push(...bytes);
        break;
      }
      default: {
        // nested message: item is an object, encoded recursively by the caller
        const bytes = Buffer.isBuffer(item) ? item : item;
        encodeTag(number, WIRE.LEN, out);
        writeVarint(bytes.length, out);
        out.push(...bytes);
        break;
      }
    }
  }
}

/**
 * Encode a message using a schema field list.
 * Nested messages must already be encoded Buffers.
 */
export function encode(schema, message) {
  const out = [];
  for (const field of schema) {
    const value = message[field.name];
    if (value === undefined || value === null) continue;
    encodeField(field.number, field.type, value, field.repeated, out);
  }
  return Buffer.from(out);
}

// ------------------------------------------------------------------- decoding

/**
 * Decode a message into `{ [fieldNumber]: value }`.
 *
 * Length-delimited fields stay as Buffers: the caller decides whether they are
 * strings, nested messages or JSON blobs. That avoids needing the full schema at
 * decode time, which is what makes a generic dumper possible.
 */
export function decodeRaw(buf) {
  const result = {};
  let pos = 0;

  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const number = Math.floor(tag / 8);
    const wire = tag & 7;

    let value;
    if (wire === WIRE.VARINT) {
      [value, pos] = readVarint(buf, pos);
    } else if (wire === WIRE.LEN) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wire === WIRE.I64) {
      value = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wire === WIRE.I32) {
      value = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      throw new RangeError(`unsupported wire type ${wire} for field ${number}`);
    }

    if (result[number] === undefined) {
      result[number] = wire === WIRE.LEN && isRepeatedCandidate(number) ? [value] : value;
    } else if (Array.isArray(result[number])) {
      result[number].push(value);
    } else {
      result[number] = [result[number], value];
    }
  }

  return result;
}

/**
 * Length-delimited fields may legitimately repeat (repeated string/bytes/message).
 * decodeRaw cannot know from the wire alone, so it always collects LEN fields into
 * arrays; typed decoding below flattens single values.
 */
function isRepeatedCandidate() {
  return true;
}

/** Decode with a schema, producing `{ [fieldName]: value }`. */
export function decode(schema, buf) {
  const raw = decodeRaw(buf);
  const out = {};
  const byNumber = new Map(schema.map((f) => [f.number, f]));

  for (const [number, value] of Object.entries(raw)) {
    const field = byNumber.get(Number(number));
    if (!field) continue;
    const values = Array.isArray(value) ? value : [value];

    const convert = (item) => {
      switch (field.type) {
        case "string":
          return Buffer.isBuffer(item) ? item.toString("utf8") : item;
        case "bytes":
          return item;
        case "bool":
          return Boolean(item);
        case "int32":
        case "uint32":
        case "int64":
        case "uint64":
        case "sint32":
        case "sint64":
        case "enum":
          return Number(item);
        default:
          return item; // nested message stays a Buffer for the caller to decode
      }
    };

    out[field.name] = field.repeated
      ? values.map(convert)
      : convert(values[values.length - 1]);
  }

  return out;
}

// ------------------------------------------------------------------- inspection

/** A length-delimited value is shown as text when every byte is printable. */
function isPrintableText(buf) {
  if (buf.length === 0) return false;
  for (const byte of buf) {
    const ok = (byte >= 0x20 && byte <= 0x7e) || byte === 0x0a || byte === 0x0d || byte === 0x09;
    if (!ok) return false;
  }
  return true;
}

/** Human-readable dump, for reverse-engineering unknown payloads. */
export function dump(buf, { depth = 0, maxDepth = 6, indent = "" } = {}) {
  const lines = [];
  const raw = decodeRaw(buf);

  for (const [number, value] of Object.entries(raw)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (Buffer.isBuffer(item)) {
        if (isPrintableText(item)) {
          lines.push(`${indent}${number}: "${item.toString("utf8").slice(0, 120)}"`);
        } else if (depth < maxDepth) {
          lines.push(`${indent}${number}: {`);
          try {
            lines.push(...dump(item, { depth: depth + 1, maxDepth, indent: indent + "  " }));
          } catch {
            lines.push(`${indent}  <${item.length} bytes>`);
          }
          lines.push(`${indent}}`);
        } else {
          lines.push(`${indent}${number}: <${item.length} bytes>`);
        }
      } else {
        lines.push(`${indent}${number}: ${item}`);
      }
    }
  }

  return lines;
}
