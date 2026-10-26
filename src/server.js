/**
 * Local BYOK server.
 *
 * Speaks the Connect protocol that Cursor's extension host already uses, so the
 * router can point a Cursor API call here without any client-side change.
 *
 * Implemented:
 *
 *   POST /aiserver.v1.AiService/AvailableModels      model list for the picker
 *   POST /aiserver.v1.BidiService/BidiAppend         the run request
 *   POST /agent.v1.AgentService/RunSSE               streamed answer
 *   POST /agent.v1.AgentService/UploadConversationBlobs  history blobs
 *   GET  /health                                     liveness
 *   GET  /byok/debug                                 connection diagnostics
 *
 * Everything else returns a Connect `unimplemented` error, which Cursor surfaces as
 * a normal RPC failure rather than a transport error — so a missing RPC is visible
 * instead of silently hanging.
 */

import http from "node:http";

import { buildAvailableModels, catalogFromProviders } from "./catalog.js";
import { loadRoot } from "./proto/schema.js";
import { endFrame, errorBody, frame, parseRpcPath } from "./proto/connect.js";
import { DEFAULT_PORT, providersFile, readJson } from "./paths.js";
import { detail, fail, info, ok } from "./ui.js";
import { putBlob } from "./agent/blobs.js";
import { closeSession, deliver, next, openSession, sessionCount, sweep } from "./agent/session.js";
import { runTurn } from "./agent/turn.js";

const UNAVAILABLE = 12; // Connect code for unimplemented
const INVALID_ARGUMENT = 3;
const INTERNAL = 13;

const AGENT_SERVICE = "agent.v1.AgentService";
const BIDI_SERVICE = "aiserver.v1.BidiService";

export function createServer({ extensionJs, port = DEFAULT_PORT, host = "127.0.0.1" } = {}) {
  let root = null;
  const stats = {
    requests: 0,
    availableModels: 0,
    bidiAppend: 0,
    runSSE: 0,
    blobs: 0,
    errors: 0,
    startedAt: Date.now(),
  };

  function getRoot() {
    if (!root) root = loadRoot(extensionJs);
    return root;
  }

  function lookup(name) {
    return getRoot().lookupType(name);
  }

  function decode(name, body) {
    return lookup(name).decode(body);
  }

  function encode(name, value) {
    const Type = lookup(name);
    return Buffer.from(Type.encode(Type.fromObject(value ?? {})).finish());
  }

  const server = http.createServer((req, res) => {
    stats.requests += 1;

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: "byok" }));
      return;
    }

    if (req.method === "GET" && pathname === "/byok/debug") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          uptimeMs: Date.now() - stats.startedAt,
          sessions: sessionCount(),
          ...stats,
        }),
      );
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

    stats.errors += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(errorBody(UNAVAILABLE, `${route} not implemented`));
  });

  /** Collect a unary request body, then answer with a protobuf message. */
  function unary(req, res, handler) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = handler(Buffer.concat(chunks));
        res.writeHead(200, {
          "content-type": "application/proto",
          "content-length": body.length,
        });
        res.end(body);
      } catch (error) {
        stats.errors += 1;
        fail(`${req.url} failed: ${error.message}`);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(errorBody(INTERNAL, error.message));
      }
    });
  }

  /** One client frame: decode it, hand it to the session waiting for it. */
  function handleBidiAppend(body) {
    const append = decode("aiserver.v1.BidiAppendRequest", body);
    const requestId = append.request_id?.request_id ?? "";
    if (!requestId) throw new Error("BidiAppend without request_id");

    const payload = append.data_binary?.length
      ? Buffer.from(append.data_binary)
      : Buffer.from(append.data ?? "", "base64");

    const message = decode("agent.v1.AgentClientMessage", payload);
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
        const body = Buffer.concat(chunks);
        requestId = body.length ? decode("aiserver.v1.BidiRequestId", body).request_id : "";
        if (!requestId) throw new Error("RunSSE without request_id");

        stats.runSSE += 1;
        info(`RunSSE ${requestId.slice(0, 8)} started`);

        res.writeHead(200, {
          "content-type": "application/connect+proto",
          "connect-content-encoding": "identity",
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
          const message = await next(requestId, 60_000);
          if (!message) break;

          const queuedText = message.conversation_action?.user_message_action?.user_message?.text;
          if (typeof queuedText === "string" && queuedText.length > 0) queued = queuedText;

          if (message.run_request) {
            runRequest = message.run_request;
            break;
          }
        }

        if (!runRequest) {
          res.end(endFrame({ error: { code: "deadline_exceeded", message: "no run request arrived" } }));
          closeSession(requestId);
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

export { INVALID_ARGUMENT, openSession };
