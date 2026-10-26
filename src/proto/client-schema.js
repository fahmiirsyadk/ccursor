/**
 * Cursor's own protobuf schema.
 *
 * Cursor's client is generated with protobuf-es, and the generated code ships inside
 * the workbench bundle as three kinds of object literal:
 *
 *   X=makeMessageType("agent.v1.AgentRunRequest",()=>[{no:1,name:"...",kind:"scalar",T:9}])
 *   X=makeEnum("agent.v1.AgentMode",[{no:0,name:"AGENT_MODE_UNSPECIFIED"}])
 *   X={typeName:"agent.v1.AgentService",methods:{run:{name:"Run",I:VAR,O:VAR,kind:se.Unary}}}
 *
 * This is the schema the client actually encodes and decodes with, so it is a better
 * source than the BYOK extension's copy, which is a separate and older artifact.
 * Reading it here also removes the last thing this tool needed that extension for.
 *
 * The literals are parsed rather than evaluated: running Cursor's bundle would need
 * its module loader, and evaluating minified third-party code to read a schema is a
 * poor trade. Only the field descriptors are read, with a scanner for this exact
 * shape.
 */

import fs from "node:fs";

/** protobuf-es scalar type codes, in the order the enum declares them. */
const SCALARS = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  12: "bytes",
  13: "uint32",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64",
};

/** Method kinds, as protobuf-es names them. */
const STREAMING = {
  Unary: { requestStream: false, responseStream: false },
  ServerStreaming: { requestStream: false, responseStream: true },
  ClientStreaming: { requestStream: true, responseStream: false },
  BiDiStreaming: { requestStream: true, responseStream: true },
};

/** Index of the bracket that closes the one at `open`. */
function matchBracket(source, open) {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const stack = [];
  let quote = null;

  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (pairs[char]) stack.push(pairs[char]);
    else if (char === "}" || char === "]" || char === ")") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Split `{a:1,b:2}` into ["a:1", "b:2"] at the top level. */
function splitTopLevel(body) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let quote = null;

  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("{[(".includes(char)) depth += 1;
    else if ("}])".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (body.slice(start).trim().length > 0) parts.push(body.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Read `key:value` pairs out of one object literal body. */
function readPairs(body) {
  const out = {};
  for (const part of splitTopLevel(body)) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/** Read a string literal. */
function readString(raw) {
  const match = /^"((?:[^"\\]|\\.)*)"$/.exec(raw ?? "");
  return match ? match[1].replace(/\\(.)/g, "$1") : null;
}

/**
 * Resolve a type reference.
 *
 * Generated code writes it as one of:
 *   T:9                              scalar code
 *   T:VAR                            a message, by variable
 *   T:()=>VAR                        a message, lazily
 *   T:S.getEnumType(VAR)             an enum
 */
function readType(raw, vars) {
  const scalar = /^(\d+)$/.exec(raw ?? "");
  if (scalar) return { kind: "scalar", type: SCALARS[Number(scalar[1])] ?? null };

  const enumRef = /^[\w.$]+\.getEnumType\(([\w$]+)\)$/.exec(raw ?? "");
  if (enumRef) return { kind: "enum", ref: vars.get(enumRef[1]) ?? null };

  const lazy = /^\(\)=>([\w$]+)$/.exec(raw ?? "");
  if (lazy) return { kind: "message", ref: vars.get(lazy[1]) ?? null };

  if (/^[\w$]+$/.test(raw ?? "")) return { kind: "message", ref: vars.get(raw) ?? null };

  return { kind: null, ref: null };
}

/** Parse one field descriptor. */
function readField(body, vars) {
  const pairs = readPairs(body);

  const field = {
    no: Number(pairs.no),
    name: readString(pairs.name),
    kind: readString(pairs.kind),
    repeated: pairs.repeated === "!0",
    oneof: readString(pairs.oneof),
  };

  if (!field.no || !field.name) return null;

  if (field.kind === "map") {
    const key = /^(\d+)$/.exec(pairs.K ?? "");
    const value = readPairs((pairs.V ?? "").replace(/^\{|\}$/g, ""));
    field.keyType = key ? SCALARS[Number(key[1])] ?? "string" : "string";
    const resolved = readType(value.T, vars);
    field.valueKind = resolved.kind;
    field.valueType = resolved.type ?? resolved.ref;
    return field;
  }

  const resolved = readType(pairs.T, vars);
  field.kind = resolved.kind ?? field.kind;
  field.type = resolved.type ?? resolved.ref;
  if (!field.type) field.raw = pairs.T;
  return field;
}

/** Insert a dotted name into a protobufjs JSON tree. */
function nest(root, fullName) {
  const parts = fullName.split(".");
  let node = root;

  for (let i = 0; i < parts.length - 1; i += 1) {
    node.nested ??= {};
    node.nested[parts[i]] ??= { nested: {} };
    node = node.nested[parts[i]];
    node.nested ??= {};
  }

  const leaf = parts[parts.length - 1];
  node.nested ??= {};
  node.nested[leaf] ??= {};
  return node.nested[leaf];
}

/** protobufjs wants fully-qualified references prefixed with a dot. */
const qualify = (name) => (name ? `.${name}` : null);

/**
 * Parse the schema out of a bundle.
 *
 * @param {string} source contents of workbench.desktop.main.js
 * @returns {{json: object, stats: object}}
 */
export function parseClientSchema(source) {
  const vars = new Map();
  const messageBodies = [];
  const enumBodies = [];
  const services = [];

  // Pass 1: variable names, so type references can be resolved in any order.
  // Minified identifiers may contain "$", so \w is not enough.
  for (const match of source.matchAll(/([\w$]+)\s*=\s*[\w$]+\.makeMessageType\("([\w.]+)"/g)) {
    vars.set(match[1], match[2]);
  }
  for (const match of source.matchAll(/([\w$]+)\s*=\s*[\w$]+\.makeEnum\("([\w.]+)"/g)) {
    vars.set(match[1], match[2]);
  }

  // The google.protobuf types are hand-written classes rather than generated
  // literals: `X=class ... extends Mg{...},X.typeName="google.protobuf.Struct",
  // X.fields=S.util.newFieldList(()=>[...])`. Their names are on the class itself.
  for (const match of source.matchAll(/([\w$]+)\.typeName\s*=\s*"([\w.]+)"/g)) {
    vars.set(match[1], match[2]);
  }
  for (const match of source.matchAll(/\.setEnumType\(([\w$]+)\s*,\s*"([\w.]+)"/g)) {
    vars.set(match[1], match[2]);
  }

  // Aliases: `ALIAS=VAR` with nothing else on the right. Repeat, because an alias
  // can itself be aliased.
  for (let round = 0; round < 4; round += 1) {
    let added = false;
    for (const match of source.matchAll(/([\w$]+)\s*=\s*([\w$]+)(?=\s*[,;)}])/g)) {
      const [, alias, target] = match;
      if (alias === target || vars.has(alias) || !vars.has(target)) continue;
      vars.set(alias, vars.get(target));
      added = true;
    }
    if (!added) break;
  }

  // Pass 2: the literals.
  // Two shapes: a field list, and an empty message written as [] with no thunk.
  for (const match of source.matchAll(/\w+\.makeMessageType\("([\w.]+)",\s*(?:\(\)\s*=>\s*)?\[/g)) {
    const arrayOpen = source.indexOf("[", match.index + match[0].length - 1);
    const arrayEnd = matchBracket(source, arrayOpen);
    if (arrayEnd < 0) continue;
    messageBodies.push({ name: match[1], body: source.slice(arrayOpen + 1, arrayEnd) });
  }

  for (const match of source.matchAll(/\w+\.makeEnum\("([\w.]+)",\s*\[/g)) {
    const arrayOpen = source.indexOf("[", match.index + match[0].length - 1);
    const arrayEnd = matchBracket(source, arrayOpen);
    if (arrayEnd < 0) continue;
    enumBodies.push({ name: match[1], body: source.slice(arrayOpen + 1, arrayEnd) });
  }

  // Hand-written classes: fields live in a `newFieldList(()=>[...])` call.
  // One scan over the bundle, not one scan per type: a regex per variable would
  // walk 41 MB several thousand times.
  for (const match of source.matchAll(/([\w$]+)\.fields\s*=\s*[\w$.]+\.newFieldList\(\(\)\s*=>\s*\[/g)) {
    const name = vars.get(match[1]);
    if (!name) continue;
    const arrayOpen = source.indexOf("[", match.index + match[0].length - 1);
    const arrayEnd = matchBracket(source, arrayOpen);
    if (arrayEnd < 0) continue;
    messageBodies.push({ name, body: source.slice(arrayOpen + 1, arrayEnd) });
  }

  // setEnumType also defines an enum inline.
  for (const match of source.matchAll(/\.setEnumType\([\w$]+\s*,\s*"([\w.]+)"\s*,\s*\[/g)) {
    const arrayOpen = source.indexOf("[", match.index + match[0].length - 1);
    const arrayEnd = matchBracket(source, arrayOpen);
    if (arrayEnd < 0) continue;
    enumBodies.push({ name: match[1], body: source.slice(arrayOpen + 1, arrayEnd) });
  }

  for (const match of source.matchAll(/\{typeName:"([\w.]+)",\s*methods:\{/g)) {
    const open = source.indexOf("{", match.index + match[0].length - 1);
    const end = matchBracket(source, open);
    if (end < 0) continue;
    services.push({ name: match[1], body: source.slice(open + 1, end) });
  }

  const json = { nested: {} };
  let dropped = 0;
  /** Raw type expressions we could not resolve, and how often. */
  const unresolved = new Map();

  for (const { name, body } of enumBodies) {
    const values = {};
    for (const part of splitTopLevel(body)) {
      const pairs = readPairs(part.replace(/^\{|\}$/g, ""));
      const valueName = readString(pairs.name);
      const number = Number(pairs.no);
      if (valueName && Number.isFinite(number)) values[valueName] = number;
    }
    if (Object.keys(values).length === 0) continue;
    nest(json, name).values = values;
  }

  for (const { name, body } of messageBodies) {
    const fields = {};
    const oneofs = {};

    for (const part of splitTopLevel(body)) {
      if (!part.startsWith("{")) continue;
      const field = readField(part.slice(1, -1), vars);
      if (!field) continue;

      const entry = { id: field.no };

      if (field.kind === "map") {
        // A map value may be a scalar, which protobufjs wants unqualified.
        entry.keyType = field.keyType;
        entry.type = field.valueKind === "scalar" ? field.valueType : qualify(field.valueType);
      } else {
        entry.type =
          field.kind === "scalar" ? field.type : qualify(field.type);
        if (field.repeated) entry.rule = "repeated";
      }

      if (field.oneof) {
        entry.oneof = field.oneof;
        oneofs[field.oneof] ??= { oneof: [] };
        oneofs[field.oneof].oneof.push(field.name);
      }

      // A reference we could not resolve would silently become a string field,
      // which is worse than leaving the field out — but it is counted, so a schema
      // that loses fields is visible rather than quietly smaller.
      if (!entry.type) {
        dropped += 1;
        unresolved.set(field.raw ?? "?", (unresolved.get(field.raw ?? "?") ?? 0) + 1);
        continue;
      }
      fields[field.name] = entry;
    }

    const node = nest(json, name);
    node.fields = fields;
    if (Object.keys(oneofs).length > 0) node.oneofs = oneofs;
  }

  let incomplete = 0;
  let methodCount = 0;

  for (const { name, body } of services) {
    const methods = {};

    for (const part of splitTopLevel(body)) {
      const at = part.indexOf(":");
      if (at < 0) continue;
      const inner = part.slice(at + 1).trim();
      if (!inner.startsWith("{")) continue;

      const pairs = readPairs(inner.slice(1, -1));
      const methodName = readString(pairs.name);
      if (!methodName) continue;

      // A handful of methods reference types that live in a chunk this bundle does
      // not contain. protobufjs rejects a method without both types, and a route we
      // cannot describe is answered as an empty message anyway, so it is skipped
      // rather than guessed at.
      const requestType = qualify(vars.get(pairs.I));
      const responseType = qualify(vars.get(pairs.O));
      if (!requestType || !responseType) {
        incomplete += 1;
        continue;
      }

      const streaming = STREAMING[(pairs.kind ?? "").split(".").pop()] ?? STREAMING.Unary;
      methods[methodName] = { requestType, responseType, ...streaming };
      methodCount += 1;
    }

    if (Object.keys(methods).length > 0) nest(json, name).methods = methods;
  }

  return {
    json,
    stats: {
      messages: messageBodies.length,
      enums: enumBodies.length,
      services: services.length,
      methods: methodCount,
      incomplete,
      droppedFields: dropped,
      unresolved: Object.fromEntries([...unresolved.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)),
    },
  };
}

/** Read and parse a bundle from disk. */
export function readClientSchema(bundlePath) {
  return parseClientSchema(fs.readFileSync(bundlePath, "utf8"));
}
