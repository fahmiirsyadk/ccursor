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

export { PINNED as PACKAGE, install } from "./vendor.js";

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
