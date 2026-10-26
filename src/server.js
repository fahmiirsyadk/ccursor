/**
 * Local BYOK server.
 *
 * Replaces the third-party Fastify-based server. Only what Cursor actually calls is
 * implemented, and the surface grows one RPC at a time so each addition is provable.
 *
 * Current surface:
 *   POST /aiserver.v1.AiService/AvailableModels   model list for the picker
 *   GET  /health                                  liveness
 *   GET  /byok/debug                              connection diagnostics
 *
 * Everything else returns a Connect `unimplemented` error, which Cursor surfaces as
 * a normal RPC failure rather than a transport error — so a missing RPC is visible
 * instead of silently hanging.
 */

import http from "node:http";

import { buildAvailableModels, catalogFromProviders } from "./catalog.js";
import { loadRoot } from "./proto/schema.js";
import { errorBody, parseRpcPath } from "./proto/connect.js";
import { DEFAULT_PORT } from "./paths.js";
import { detail, fail, info, ok } from "./ui.js";

const UNAVAILABLE = 12; // Connect code for unimplemented

export function createServer({ extensionJs, port = DEFAULT_PORT, host = "127.0.0.1" } = {}) {
  let root = null;
  const stats = { requests: 0, availableModels: 0, errors: 0, startedAt: Date.now() };

  function getRoot() {
    if (!root) root = loadRoot(extensionJs);
    return root;
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

    if (rpc.service === "aiserver.v1.AiService" && rpc.method === "AvailableModels") {
      handleAvailableModels(req, res);
      return;
    }

    stats.errors += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(errorBody(UNAVAILABLE, `${rpc.service}/${rpc.method} not implemented`));
  });

  function handleAvailableModels(req, res) {
    // The request body is a protobuf message; we do not need its contents yet.
    req.resume();
    req.on("end", () => {
      try {
        const body = buildAvailableModels(getRoot(), catalogFromProviders());
        stats.availableModels += 1;
        res.writeHead(200, {
          "content-type": "application/proto",
          "content-length": body.length,
        });
        res.end(body);
      } catch (error) {
        stats.errors += 1;
        fail(`AvailableModels failed: ${error.message}`);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(errorBody(13, error.message));
      }
    });
  }

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
