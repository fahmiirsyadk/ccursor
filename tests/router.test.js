/**
 * Router and Connect framing behaviour.
 *
 * These two pieces carry every byte between Cursor and the provider, so they are
 * tested against the wire, not just against each other.
 */

import assert from "node:assert/strict";
import http from "node:http";
import { after, describe, it } from "node:test";

import { FrameReader, endFrame, frame, parseRpcPath } from "../src/proto/connect.js";
import { pathOnly, rewriteUrl, shouldRedirect, install } from "../src/router.js";

describe("routing is decided by path, not host", () => {
  // The path is the part of the contract the client cannot vary: it is the RPC it
  // is calling. Hostnames change between Cursor releases; matching on them would
  // fail silently.
  const routes = ["agent.v1.AgentService/RunSSE"];

  it("diverts the same path on any host", () => {
    for (const host of [
      "api2.cursor.sh",
      "api4.cursor.sh",
      "gcpp.cursor.sh",
      "some-new-host.cursor.sh",
    ]) {
      const url = `https://${host}/agent.v1.AgentService/RunSSE`;
      assert.equal(shouldRedirect(new URL(url).pathname, routes), true, host);
    }
  });

  it("leaves other paths alone regardless of host", () => {
    assert.equal(shouldRedirect("/marketplace/items", routes), false);
    assert.equal(shouldRedirect("/update/check", routes), false);
  });
});

describe("route matching", () => {
  const routes = [
    "aiserver.v1.AiService/AvailableModels",
    "agent.v1.AgentService/RunSSE",
    "aiserver.v1.DashboardService",
    "REST:/auth/stripe_profile",
  ];

  it("matches an exact method rule", () => {
    assert.equal(shouldRedirect("/aiserver.v1.AiService/AvailableModels", routes), true);
    assert.equal(shouldRedirect("/agent.v1.AgentService/RunSSE", routes), true);
  });

  it("matches a whole-service rule", () => {
    assert.equal(shouldRedirect("/aiserver.v1.DashboardService/GetPlanInfo", routes), true);
  });

  it("matches a REST path", () => {
    assert.equal(shouldRedirect("/auth/stripe_profile", routes), true);
  });

  it("leaves unlisted paths alone", () => {
    assert.equal(shouldRedirect("/aiserver.v1.AiService/GetSimplePrompt", routes), false);
    assert.equal(shouldRedirect("/telemetry/event", routes), false);
  });

  it("ignores the query string", () => {
    assert.equal(pathOnly("/a/b?x=1#frag"), "/a/b");
    assert.equal(shouldRedirect("/auth/stripe_profile?x=1", routes), true);
  });

  it("rewrites to the local base keeping path and query", () => {
    assert.equal(
      rewriteUrl("https://api2.cursor.sh/a/b?x=1", "http://127.0.0.1:39831"),
      "http://127.0.0.1:39831/a/b?x=1",
    );
  });
});

describe("connect framing", () => {
  it("frames a message with a 5-byte envelope", () => {
    const framed = frame(Buffer.from("abc"));
    assert.equal(framed.length, 8);
    assert.equal(framed[0], 0x00);
    assert.equal(framed.readUInt32BE(1), 3);
    assert.equal(framed.subarray(5).toString(), "abc");
  });

  it("marks the end frame", () => {
    const end = endFrame({});
    assert.equal(end[0], 0x02);
  });

  it("reads frames split across chunks", () => {
    const reader = new FrameReader();
    const a = frame(Buffer.from("hello"));
    const b = frame(Buffer.from("world"));

    // feed one byte at a time
    const collected = [];
    for (const byte of Buffer.concat([a, b])) {
      for (const f of reader.push(Buffer.from([byte]))) collected.push(f.payload.toString());
    }

    assert.deepEqual(collected, ["hello", "world"]);
    assert.equal(reader.remainder.length, 0);
  });

  it("keeps a partial frame buffered", () => {
    const reader = new FrameReader();
    const full = frame(Buffer.from("abcdef"));
    const first = reader.push(full.subarray(0, 4));

    assert.equal(first.length, 0);
    assert.equal(reader.remainder.length, 4);

    const second = reader.push(full.subarray(4));
    assert.equal(second.length, 1);
    assert.equal(second[0].payload.toString(), "abcdef");
  });

  it("parses rpc paths", () => {
    assert.deepEqual(parseRpcPath("/aiserver.v1.AiService/AvailableModels"), {
      service: "aiserver.v1.AiService",
      method: "AvailableModels",
    });
    assert.equal(parseRpcPath("/health"), null);
  });
});

describe("router end to end", () => {
  it("diverts a matching call to the local server and leaves others alone", async () => {
    const hits = [];
    const local = http.createServer((req, res) => {
      hits.push(req.url);
      res.writeHead(200, { "content-type": "application/proto" });
      res.end(Buffer.from([0x0a, 0x01, 0x41]));
    });
    await new Promise((resolve) => local.listen(0, "127.0.0.1", resolve));
    const port = local.address().port;

    const hook = install({
      localBase: `http://127.0.0.1:${port}`,
      routes: ["aiserver.v1.AiService/AvailableModels"],
    });

    try {
      // matching path: should hit the local server
      const diverted = await new Promise((resolve, reject) => {
        const req = http.request(
          "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels",
          { method: "POST" },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
          },
        );
        req.on("error", reject);
        req.end();
      });

      assert.equal(diverted.status, 200);
      assert.equal(diverted.body.toString("hex"), "0a0141");
      assert.deepEqual(hits, ["/aiserver.v1.AiService/AvailableModels"]);
    } finally {
      hook.uninstall();
      await new Promise((resolve) => local.close(resolve));
    }
  });

  it("installs once", () => {
    const hook = install({ localBase: "http://127.0.0.1:1", routes: [] });
    const again = install({ localBase: "http://127.0.0.1:2", routes: [] });
    try {
      assert.equal(hook, again);
    } finally {
      hook.uninstall();
    }
  });
});
