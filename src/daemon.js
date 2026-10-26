/**
 * Server lifecycle.
 *
 * The server has to be listening before Cursor starts, because the router inside
 * Cursor's extension hosts sends traffic here. `run` starts it, waits until it
 * answers, and only then launches Cursor. `serve` runs the same server in the
 * foreground for a terminal or a unit file.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cursorRunning } from "./seed.js";
import { DEFAULT_PORT, stateDir } from "./paths.js";
import { detail, info, ok, warn } from "./ui.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = () => path.join(here, "cli.js");
const pidFile = () => path.join(stateDir(), "server.pid");
const logFile = () => path.join(stateDir(), "server.log");

/**
 * Ask a running server whether it is ours.
 *
 * The reply identifies the server, so a process that happens to hold the port is
 * not mistaken for this one.
 *
 * @returns {Promise<"ours"|"other"|"down">}
 */
export async function health(port = DEFAULT_PORT, timeoutMs = 800) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return "other";

    const body = await response.json();
    return body?.server === "ccursor-byok" ? "ours" : "other";
  } catch {
    return "down";
  }
}

/** Wait for the server to answer, or give up. */
export async function waitForServer(port = DEFAULT_PORT, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const state = await health(port);
    if (state === "ours") return true;
    if (state === "other") return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

/** The pid we recorded, if that process is still alive. */
export function runningPid() {
  try {
    const pid = Number(fs.readFileSync(pidFile(), "utf8").trim());
    if (!pid) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

/**
 * Start the server in the background unless one is already answering.
 *
 * @param {object} options
 * @param {string} options.appRoot patched Cursor install
 * @param {number} [options.port]
 * @returns {Promise<"already-running"|"started"|"failed"|"port-taken">}
 */
export async function ensureServer({ appRoot, port = DEFAULT_PORT }) {
  const current = await health(port);
  if (current === "ours") return "already-running";
  if (current === "other") return "port-taken";

  fs.mkdirSync(stateDir(), { recursive: true });
  const log = fs.openSync(logFile(), "a");

  const child = spawn(
    process.execPath,
    [cliPath(), "serve", "--app", appRoot, "--port", String(port)],
    { detached: true, stdio: ["ignore", log, log] },
  );
  child.unref();
  fs.closeSync(log);

  if (child.pid) fs.writeFileSync(pidFile(), String(child.pid));

  if (await waitForServer(port)) return "started";

  warn(`server did not answer on port ${port} — see ${logFile()}`);
  return "failed";
}

/**
 * Stop the recorded server.
 *
 * Refuses while Cursor is running: the router inside Cursor would then send traffic
 * to a port with nothing on it, and every turn would fail until Cursor restarts.
 */
export function stopServer({ force = false } = {}) {
  const pid = runningPid();
  if (!pid) {
    detail("no server pid recorded");
    return false;
  }

  if (!force && cursorRunning()) {
    warn("Cursor is running; stopping now would break every turn until it restarts");
    detail("quit Cursor first, or pass --force to stop anyway");
    return false;
  }

  try {
    process.kill(pid, "SIGTERM");
    fs.rmSync(pidFile(), { force: true });
    ok(`stopped server ${pid}`);
    return true;
  } catch (error) {
    warn(`could not stop ${pid}: ${error.message}`);
    return false;
  }
}

/** Describe the server state for `status`. */
export async function describe(port = DEFAULT_PORT) {
  const state = await health(port);
  if (state === "ours") return `running on ${port}`;
  if (state === "other") return `port ${port} is held by another process`;
  const pid = runningPid();
  return pid ? `recorded pid ${pid}, not answering` : "not running";
}

/** Print the log path so a failure is actionable. */
export function logPath() {
  return logFile();
}

export { info };
