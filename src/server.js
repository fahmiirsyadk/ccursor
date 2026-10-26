/**
 * Local BYOK server.
 *
 * Speaks the Connect protocol that Cursor's extension host already uses, so the
 * router can point a Cursor API call here without any client-side change.
 *
 * Three kinds of route:
 *
 *   1. Implemented here      model listing, the agent loop, blob upload
 *   2. Answered locally      clock, default model, plan, usage, analytics
 *   3. Unknown               an empty response of the right type, or a clear
 *                            Connect error when the service does not exist
 *
 * Nothing is forwarded to Cursor. That is the point: the account this runs under
 * needs no plan, no seat, and no data leaving the machine.
 */

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { buildAvailableModels, catalogFromProviders } from "./catalog.js";
import { loadRoot } from "./proto/schema.js";
import {
  decompress,
  endFrame,
  errorBody,
  frame,
  parseRpcPath,
  readStreamRequest,
  requestEncoding,
} from "./proto/connect.js";
import { DEFAULT_PORT, providersFile, readJson } from "./paths.js";
import { detail, fail, info, ok, warn } from "./ui.js";
import { putBlob } from "./agent/blobs.js";
import { closeSession, deliver, next, openSession, sessionCount, sweep } from "./agent/session.js";
import { runTurn } from "./agent/turn.js";
import { HANDLERS, REST } from "./local/api.js";
import { SINK_PATH } from "./local/telemetry.js";

const UNAVAILABLE = 12; // Connect code for unimplemented

/** How long RunSSE waits for the matching BidiAppend before giving up. */
const RUN_REQUEST_WAIT_MS = 30_000;
const INTERNAL = 13;

const AGENT_SERVICE = "agent.v1.AgentService";
const BIDI_SERVICE = "aiserver.v1.BidiService";

export function createServer({ extensionJs, port = DEFAULT_PORT, host = "127.0.0.1" } = {}) {
  let root = null;
  let methods = null;
  /** Routes the client asked for that the cached schema does not know. */
  const unknownRoutes = new Map();

  const stats = {
    requests: 0,
    availableModels: 0,
    bidiAppend: 0,
    runSSE: 0,
    blobs: 0,
    local: 0,
    empty: 0,
    unknown: 0,
    sink: 0,
    errors: 0,
    startedAt: Date.now(),
  };

  function getRoot() {
    if (!root) root = loadRoot(extensionJs);
    return root;
  }

  /** service/method -> protobufjs Method, for response types and streaming flags. */
  function getMethods() {
    if (methods) return methods;
    methods = new Map();
    const schema = getRoot();

    const walk = (namespace) => {
      for (const nested of namespace.nestedArray ?? []) {
        if (nested.methods) {
          const service = nested.fullName.replace(/^\./, "");
          for (const [name, method] of Object.entries(nested.methods)) {
            methods.set(`${service}/${name}`, method);
          }
          continue;
        }
        walk(nested);
      }
    };
    walk(schema);

    return methods;
  }

  function decode(name, body) {
    return getRoot().lookupType(name).decode(body);
  }

  function encode(name, value) {
    const Type = getRoot().lookupType(name);
    return Buffer.from(Type.encode(Type.fromObject(value ?? {})).finish());
  }

  function encodeEmpty(method) {
    const name = String(method.responseType).replace(/^\./, "");
    return encode(name, {});
  }

  const server = http.createServer((req, res) => {
    stats.requests += 1;

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: "byok", server: "ccursor-byok" }));
      return;
    }

    if (req.method === "GET" && pathname === "/byok/debug") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          uptimeMs: Date.now() - stats.startedAt,
          sessions: sessionCount(),
          unknownRoutes: Object.fromEntries(unknownRoutes),
          ...stats,
        }),
      );
      return;
    }

    // Telemetry the router sent here. Answer and forget: the caller only wants to
    // know the report was accepted.
    if (pathname === SINK_PATH) {
      stats.sink += 1;
      req.resume();
      res.writeHead(204);
      res.end();
      return;
    }

    // The renderer's hook opens this and expects it to stay open. It carries model
    // refreshes; we have nothing to push yet, but closing it makes the hook log an
    // error on every boot.
    if (pathname === "/byok/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const keepAlive = setInterval(() => res.write(": ping\n\n"), 25_000);
      keepAlive.unref?.();
      req.on("close", () => clearInterval(keepAlive));
      return;
    }

    const rest = REST[pathname];
    if (rest) {
      stats.local += 1;
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(rest()));
      return;
    }

    const rpc = parseRpcPath(pathname);
    if (!rpc) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const route = `${rpc.service}/${rpc.method}`;

    if (route === "aiserver.v1.AiService/AvailableModels") {
      unary(req, res, () => {
        const body = buildAvailableModels(getRoot(), catalogFromProviders());
        stats.availableModels += 1;
        return body;
      });
      return;
    }

    if (route === `${BIDI_SERVICE}/BidiAppend`) {
      unary(req, res, (body) => {
        handleBidiAppend(body);
        return encode("aiserver.v1.BidiAppendResponse", {});
      });
      return;
    }

    if (route === `${AGENT_SERVICE}/UploadConversationBlobs`) {
      unary(req, res, (body) => {
        const request = decode("agent.v1.UploadConversationBlobsRequest", body);
        for (const blob of request.blobs ?? []) {
          const id = Buffer.from(blob.id ?? []).toString("utf8");
          const value = Buffer.from(blob.value ?? []).toString("base64");
          putBlob(id, value);
          stats.blobs += 1;
        }
        return encode("agent.v1.UploadConversationBlobsResponse", {});
      });
      return;
    }

    if (route === `${AGENT_SERVICE}/RunSSE`) {
      handleRunSSE(req, res);
      return;
    }

    const method = getMethods().get(route);
    if (!method) {
      // The client can be newer than the schema we have: the extension bundle that
      // carries it is a separate, older artifact. Answering with an empty message
      // keeps the IDE quiet — an empty protobuf is a valid encoding of every
      // response type — while the counter records what we were asked for.
      stats.unknown += 1;
      unknownRoutes.set(route, (unknownRoutes.get(route) ?? 0) + 1);
      warn(`${route} is not in the cached schema; answered with an empty message`);
      unary(req, res, () => Buffer.alloc(0));
      return;
    }

    if (method.responseStream) {
      streamEmpty(req, res);
      return;
    }

    const handler = HANDLERS[route];
    unary(req, res, (body) => {
      if (handler) {
        stats.local += 1;
        return encode(String(method.responseType).replace(/^\./, ""), handler(safeDecode(method, body)));
      }
      stats.empty += 1;
      return encodeEmpty(method);
    });
  });

  /** Decode the request, tolerating an empty or truncated body. */
  function safeDecode(method, body) {
    if (!body || body.length === 0) return {};
    try {
      return decode(String(method.requestType).replace(/^\./, ""), body);
    } catch {
      return {};
    }
  }

  /** Collect a unary request body, then answer with a protobuf message. */
  function unary(req, res, handler) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks);
        const encoding = requestEncoding(req.headers);
        let body;
        try {
          body = decompress(raw, encoding);
        } catch (error) {
          dumpFailure(req, raw, encoding, error.message);
          throw error;
        }
        if (process.env.CURSOR_BYOK_DUMP) dumpBody(req, raw, body, encoding);
        const out = handler(body);
        res.writeHead(200, {
          "content-type": "application/proto",
          "content-length": out.length,
        });
        res.end(out);
      } catch (error) {
        stats.errors += 1;
        fail(`${req.url} failed: ${error.message}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(errorBody(INTERNAL, error.message));
      }
    });
  }

  /** Keep a request we could not read, so the shape can be inspected later. */
  function dumpFailure(req, raw, encoding, message) {
    try {
      const dir = path.join(os.tmpdir(), "byok-dump");
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${req.url.split("/").pop()}`;
      fs.writeFileSync(path.join(dir, `${name}.bin`), raw);
      fs.writeFileSync(
        path.join(dir, `${name}.json`),
        JSON.stringify({ url: req.url, headers: req.headers, encoding, message, head: raw.subarray(0, 24).toString("hex") }, null, 2),
      );
    } catch {
      /* diagnostics must never break the reply */
    }
  }

  function dumpBody(req, raw, body, encoding) {
    try {
      const dir = path.join(os.tmpdir(), "byok-dump");
      fs.mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${req.url.split("/").pop()}-ok`;
      fs.writeFileSync(path.join(dir, `${name}.raw`), raw);
      fs.writeFileSync(path.join(dir, `${name}.decoded`), body);
    } catch {
      /* ignore */
    }
  }

  /** A stream with nothing in it, for RPCs we answer but do not stream. */
  function streamEmpty(req, res) {
    stats.empty += 1;
    req.resume();
    res.writeHead(200, { "content-type": "application/connect+proto" });
    res.end(endFrame({}));
  }

  /** One client frame: decode it, hand it to the session waiting for it. */
  function handleBidiAppend(body) {
    const append = decode("aiserver.v1.BidiAppendRequest", body);
    const requestId = append.request_id?.request_id ?? "";
    if (!requestId) throw new Error("BidiAppend without request_id");

    // `data` is hex-encoded, not base64: 66811 bytes arrive as a 133622-character
    // string. `data_binary` is the raw form, used when the payload is not text.
    const payload = append.data_binary?.length
      ? Buffer.from(append.data_binary)
      : Buffer.from(append.data ?? "", "hex");

    if (payload.length === 0) {
      detail(`BidiAppend ${requestId.slice(0, 8)} empty`);
      return;
    }

    let message;
    try {
      message = decode("agent.v1.AgentClientMessage", payload);
    } catch (error) {
      // A frame we cannot read is not worth failing the whole turn over: the
      // client retries, and a heartbeat that fails to parse changes nothing.
      warn(`BidiAppend ${requestId.slice(0, 8)} undecodable: ${error.message}`);
      return;
    }

    stats.bidiAppend += 1;

    const kind = Object.keys(message).find((key) => {
      const value = message[key];
      return value !== undefined && value !== null && !(typeof value === "object" && Object.keys(value).length === 0);
    });
    detail(`BidiAppend ${requestId.slice(0, 8)} seq=${append.append_seqno ?? 0} ${kind ?? "empty"}`);

    deliver(requestId, message);
  }

  /**
   * Server-streaming response.
   *
   * Frames are written as they are produced, and the last one is the end-of-stream
   * envelope Connect requires. If the client disconnects, the turn is aborted rather
   * than left to finish into a closed socket.
   */
  function handleRunSSE(req, res) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      let requestId = "";
      try {
        // A streaming request arrives framed, and may be compressed per frame.
        const messages = readStreamRequest(
          Buffer.concat(chunks),
          requestEncoding(req.headers),
        );
        const first = messages[0];
        requestId = first ? decode("aiserver.v1.BidiRequestId", first).request_id : "";
        if (!requestId) throw new Error("RunSSE without request_id");

        stats.runSSE += 1;
        info(`RunSSE ${requestId.slice(0, 8)} started`);

        res.writeHead(200, {
          "content-type": "application/connect+proto",
          "cache-control": "no-store",
        });

        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });

        // A queued message can arrive as a conversation action before the run
        // request itself; keep it and keep waiting.
        let queued = "";
        let runRequest = null;
        for (;;) {
          const message = await next(requestId, RUN_REQUEST_WAIT_MS);
          if (!message) break;

          const queuedText = message.conversation_action?.user_message_action?.user_message?.text;
          if (typeof queuedText === "string" && queuedText.length > 0) queued = queuedText;

          if (message.run_request) {
            runRequest = message.run_request;
            break;
          }
        }

        if (!runRequest) {
          // Leave the session alone: the client retries BidiAppend, and the next
          // RunSSE must still find whatever landed in the queue.
          res.end(endFrame({ error: { code: "deadline_exceeded", message: "no run request arrived" } }));
          return;
        }

        const providers = readJson(providersFile())?.providers ?? [];

        for await (const message of runTurn({
          root: getRoot(),
          request: runRequest,
          providers,
          requestId,
          queued,
          signal: controller.signal,
        })) {
          if (res.writableEnded || res.destroyed) break;
          res.write(frame(message));
        }

        if (!res.writableEnded) res.end(endFrame({}));
      } catch (error) {
        stats.errors += 1;
        fail(`RunSSE failed: ${error.message}`);
        if (!res.headersSent) {
          res.writeHead(200, { "content-type": "application/connect+proto" });
        }
        if (!res.writableEnded) {
          res.end(endFrame({ error: { code: "internal", message: error.message } }));
        }
      } finally {
        if (requestId) closeSession(requestId);
      }
    });
  }

  // Expire sessions nobody is using so a crashed turn cannot leak memory.
  const sweeper = setInterval(() => sweep(), 60_000);
  sweeper.unref?.();

  return {
    server,
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          const address = server.address();
          ok(`listening at http://${address.address}:${address.port}`);
          resolve(address);
        });
      });
    },
    close() {
      clearInterval(sweeper);
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

/** Start from the CLI, with the extension path resolved from the install. */
export async function start({ appRoot, port = DEFAULT_PORT } = {}) {
  const extensionJs = `${appRoot}/extensions/cursor2plus/dist/extension.js`;
  info(`schema source: ${extensionJs}`);
  detail(`port ${port}`);
  const instance = createServer({ extensionJs, port });
  await instance.listen();
  return instance;
}

export { openSession };
