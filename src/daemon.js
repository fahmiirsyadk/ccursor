/**
 * Server lifecycle.
 *
 * The server has to be listening before Cursor starts: the BYOK extension checks
 * the port on boot and, if something answers `/health` with `mode: "byok"`, it steps
 * aside instead of binding. That is the handover — whichever process wins the port
 * serves the traffic.
 *
 * So `run` starts a detached server, waits until it answers, and only then launches
 * Cursor. `serve` runs the same server in the foreground for a terminal or a unit
 * file.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PORT, stateDir } from "./paths.js";
import { detail, info, ok, warn } from "./ui.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = () => path.join(here, "cli.js");
const pidFile = () => path.join(stateDir(), "server.pid");
const logFile = () => path.join(stateDir(), "server.log");

/**
 * Ask a running server what it is.
 *
 * `mode: "byok"` is the handshake the extension looks for, so any BYOK server
 * answers it. `server` tells ours apart from another one already holding the port.
 */
export async function health(port = DEFAULT_PORT, timeoutMs = 800) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return "down";
    const body = await response.json();
    if (body?.mode !== "byok") return "other";
    return body?.server === "ccursor-byok" ? "byok" : "foreign";
  } catch {
    return "down";
  }
}

/** Wait for the server to answer, or give up. */
export async function waitForServer(port = DEFAULT_PORT, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    const state = await health(port);
    if (state === "byok") return true;
    if (state === "foreign") return false;
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
 * @returns {Promise<"already-running"|"started"|"failed">}
 */
export async function ensureServer({ appRoot, port = DEFAULT_PORT }) {
  const current = await health(port);
  if (current === "byok") return "already-running";
  if (current === "foreign") return "port-taken";

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

/** Stop the recorded server. */
export function stopServer() {
  const pid = runningPid();
  if (!pid) {
    detail("no server pid recorded");
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
  if (state === "byok") return `running on ${port}`;
  if (state === "foreign") return `another BYOK server holds port ${port}`;
  if (state === "other") return `port ${port} is answering, but not as a BYOK server`;
  const pid = runningPid();
  return pid ? `recorded pid ${pid}, not answering` : "not running";
}

/** Print the log path so a failure is actionable. */
export function logPath() {
  return logFile();
}

export { info };
