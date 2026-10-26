/**
 * Run the upstream @cometix/ccursor installer.
 *
 * That installer does the heavy lifting: it injects the renderer hook, installs
 * the BYOK extension, and patches the HTTP/1.1 router into `cursor-agent-host`
 * and `cursor-always-local`. We delegate rather than reimplement so upstream
 * fixes keep flowing in, and we pin the version we have tested against.
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { ROUTER_MARKER } from "./paths.js";
import { detail, fail, info, ok } from "./ui.js";

export const PACKAGE = "@cometix/ccursor@0.0.15";
const TIMEOUT_MS = 600_000;

/** True when a package runner is on PATH. */
export function available() {
  for (const runner of ["npx", "bunx"]) {
    const probe = spawnSync(runner, ["--version"], { encoding: "utf8" });
    if (probe.status === 0) return runner;
  }
  return null;
}

/** Install or repair the hook + router. Returns true on success. */
export function install(appRoot, { quiet = false } = {}) {
  const runner = available();
  if (!runner) {
    fail("npx not found; install Node.js 18+ or run the installer yourself");
    return false;
  }

  if (!quiet) info(`installing ${PACKAGE}`);

  const result = spawnSync(runner, ["-y", PACKAGE, "install"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    env: { ...process.env, CCURSOR_CURSOR_ROOT: appRoot },
  });

  if (result.error) {
    fail(`could not start the installer: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    fail("installer failed");
    const lines = (result.stderr || result.stdout || "").split("\n").filter(Boolean);
    for (const line of lines.slice(-6)) detail(line);
    return false;
  }

  if (!quiet) {
    const lines = (result.stdout || "").split("\n").filter(Boolean);
    for (const line of lines.slice(-3)) detail(line);
    ok("hook and router installed");
  }
  return true;
}

export function extensionPresent(appRoot) {
  return fs.existsSync(path.join(appRoot, "extensions", "cursor2plus"));
}

/** [always-local, agent-host] -- both must carry the router marker. */
export function routersPresent(appRoot) {
  const check = (relative) => {
    const file = path.join(appRoot, relative);
    try {
      return fs.readFileSync(file, "utf8").includes(ROUTER_MARKER);
    } catch {
      return false;
    }
  };
  return [
    check("extensions/cursor-always-local/dist/main.js"),
    check("extensions/cursor-agent-host/dist/main.js"),
  ];
}
