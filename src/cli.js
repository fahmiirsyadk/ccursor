#!/usr/bin/env node
/**
 * Command line interface.
 *
 * Subcommands are deliberately small and composable:
 *
 *   apply    patch an existing install (idempotent)
 *   status   report what is currently in effect
 *   doctor   explain why something is not working
 *   revert   restore the bundles Cursor shipped with
 *   run      seed the catalog, re-apply if needed, then launch Cursor
 *   update   extract, patch and swap in a new AppImage
 *   rule     print the agent rule that keeps tool calls sane
 */

import fs from "node:fs";
import path from "node:path";

import * as bundles from "./bundles.js";
import * as ccursor from "./ccursor.js";
import * as seed from "./seed.js";
import * as settings from "./settings.js";
import * as state from "./state.js";
import * as update from "./update.js";
import { cursorBinary, discover } from "./locate.js";
import {
  DEFAULT_PORT,
  HOOK_MARKER,
  defaultInstallDir,
  providersFile,
  routesFile,
  settingsFile,
} from "./paths.js";
import { detail, fail, heading, info, ok, warn } from "./ui.js";

const VERSION = "2.0.0";

// --------------------------------------------------------------------- helpers

function requireInstall() {
  const found = discover();
  if (!found.appRoot) {
    fail("Cursor installation not found");
    for (const candidate of found.candidates) {
      const mark = { ok: "+", partial: "~", missing: "-" }[candidate.status];
      detail(`${mark} ${candidate.path}`);
    }
    if (found.hint) warn(found.hint);
    return null;
  }
  return found;
}

async function health(port = DEFAULT_PORT) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok ? "up" : `http ${res.status}`;
  } catch {
    return "down";
  }
}

// ------------------------------------------------------------------- commands

export function cmdApply(args = {}) {
  const found = requireInstall();
  if (!found) return 1;

  const { appRoot, version } = found;
  info(`app root: ${appRoot}`);
  detail(`version ${version ?? "unknown"}`);

  if (!args.skipInstaller && !ccursor.install(appRoot)) {
    warn("continuing without the hook installer; transport will not work");
  }

  const files = bundles.bundlePaths(appRoot);
  if (files.length === 0) {
    fail("no workbench bundles found");
    return 1;
  }

  const changed = [];
  try {
    for (const file of files) {
      const data = fs.readFileSync(file, "utf8");
      const already = bundles.subscriptionPatched(data);

      let outcome;
      if (args.dryRun) {
        const [, sub] = bundles.patchSubscription(data);
        const [, admin] = bundles.patchAdminPolicy(data);
        outcome = { path: file, subscription: sub, adminPolicy: admin, changed: false };
      } else {
        // A baseline is only useful if it is pristine. Capturing one from an
        // already-patched bundle would make revert a no-op.
        if (already) {
          warn(`${path.basename(file)}: already patched, keeping the existing baseline`);
        } else {
          state.captureBaseline(file);
        }
        state.snapshot(file);
        outcome = bundles.patchBundle(file);
      }

      ok(
        `${path.basename(file)}: subscription=${outcome.subscription} admin=${outcome.adminPolicy}`,
      );
      if (outcome.changed) changed.push(file);
    }
  } catch (error) {
    if (error instanceof bundles.PatchError) {
      fail(error.message);
      return 1;
    }
    throw error;
  }

  if (args.dryRun) {
    detail("dry run: nothing written");
    return 0;
  }

  if (changed.length) {
    const updated = settings.refreshChecksums(appRoot, changed);
    if (updated) detail(`refreshed ${updated} checksum(s)`);
  }

  settings.ensureSettings();
  settings.ensureRoutes();
  state.writeMarker(appRoot, files, version);

  if (!args.skipSeed) seed.reportSeed(seed.seedCatalog({ dryRun: args.dryRun }));

  heading("result");
  ok("patched — restart Cursor");
  detail(`then confirm the BYOK toggle is on, and that ${providersFile()} lists your model`);
  detail(`health check: curl -s http://127.0.0.1:${DEFAULT_PORT}/health`);
  return 0;
}

export async function cmdStatus() {
  const found = requireInstall();
  if (!found) return 1;

  const { appRoot, version } = found;
  info(`app root: ${appRoot}`);
  detail(`version ${version ?? "unknown"}`);
  detail(state.describeMarker());

  const [alwaysLocal, agentHost] = ccursor.routersPresent(appRoot);
  const ext = ccursor.extensionPresent(appRoot);

  for (const file of bundles.bundlePaths(appRoot)) {
    const data = fs.readFileSync(file, "utf8");
    heading(path.basename(file));
    console.log(`  hook injected       : ${data.includes(HOOK_MARKER) ? "yes" : "NO"}`);
    console.log(
      `  subscription guard  : ${bundles.subscriptionPatched(data) ? "neutralised" : "VULNERABLE"}`,
    );
    console.log(
      `  admin policy guard  : ${bundles.adminPolicyPatched(data) ? "neutralised" : "VULNERABLE"}`,
    );
  }

  heading("transport");
  console.log(`  BYOK extension      : ${ext ? "installed" : "MISSING"}`);
  console.log(`  router always-local : ${alwaysLocal ? "yes" : "NO"}`);
  console.log(`  router agent-host   : ${agentHost ? "yes" : "NO"}`);

  heading("configuration");
  const cfg = readJsonOr(settingsFile());
  console.log(`  disableHttp2        : ${cfg?.[settings.DISABLE_HTTP2] ?? null}`);
  const routes = readJsonOr(routesFile());
  const port = routes?.server?.port ?? null;
  console.log(`  routes.json port    : ${port}`);
  console.log(`  providers           : ${settings.describeProviders()}`);
  console.log(`  BYOK server         : ${await health(port ?? DEFAULT_PORT)}`);
  return 0;
}

function readJsonOr(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function cmdDoctor() {
  const found = requireInstall();
  if (!found) return 1;

  const { appRoot } = found;
  info(`app root: ${appRoot}`);
  const problems = [];
  const notes = [];

  for (const file of bundles.bundlePaths(appRoot)) {
    const data = fs.readFileSync(file, "utf8");
    const name = path.basename(file);
    if (!data.includes(HOOK_MARKER)) problems.push(`${name}: renderer hook missing -> run apply`);
    if (!bundles.subscriptionPatched(data)) {
      problems.push(`${name}: subscription guard active -> BYOK turns itself off`);
    }
    if (!bundles.adminPolicyPatched(data)) {
      problems.push(`${name}: admin policy guard active -> BYOK reset on policy`);
    }
  }

  const [alwaysLocal, agentHost] = ccursor.routersPresent(appRoot);
  if (!alwaysLocal || !agentHost) {
    problems.push("HTTP/1.1 router missing in one or both extension hosts -> run apply");
  }
  if (!ccursor.extensionPresent(appRoot)) {
    problems.push("BYOK extension not installed -> run apply");
  }

  const cfg = readJsonOr(settingsFile());
  if (cfg?.[settings.DISABLE_HTTP2] !== true) {
    problems.push("cursor.general.disableHttp2 is not true -> agent turns will fail");
  }

  const routes = readJsonOr(routesFile());
  const port = routes?.server?.port;
  if (!port) {
    problems.push("routes.json missing -> run apply");
  } else if ((await health(port)) !== "up") {
    problems.push(`BYOK server not responding on port ${port} -> is Cursor running?`);
  }

  const providers = settings.describeProviders();
  if (["missing", "empty", "malformed"].includes(providers)) {
    problems.push(`${providersFile()} has no providers -> add one before sending a message`);
  }

  if (process.env.CURSOR_API_BASE_URL) {
    notes.push(
      "CURSOR_API_BASE_URL is set; unset it. The router rewrites URLs itself, and this " +
        "variable pushes HTTP/2 traffic to a plain HTTP server.",
    );
  }

  heading("checks");
  if (problems.length === 0) ok("no problems found");
  for (const problem of problems) fail(problem);
  for (const note of notes) warn(note);

  if (problems.length) {
    heading("next step");
    detail("cursor-byok apply");
    return 1;
  }
  return 0;
}

export function cmdRevert() {
  const found = requireInstall();
  if (!found) return 1;

  const { appRoot } = found;
  let restored = 0;
  for (const file of bundles.bundlePaths(appRoot)) {
    if (state.restoreBaseline(file)) {
      ok(`restored ${path.basename(file)}`);
      restored += 1;
    } else {
      warn(`no baseline for ${path.basename(file)}; leaving it as is`);
    }
  }

  if (restored) {
    settings.refreshChecksums(appRoot, bundles.bundlePaths(appRoot));
    // Baselines are kept: a later apply must capture from them, not from whatever
    // the hook installer leaves behind.
  }

  heading("result");
  ok("reverted — restart Cursor");
  return 0;
}

export async function cmdRun(args = {}) {
  const found = requireInstall();
  if (!found) return 1;

  const { appRoot, version } = found;
  const files = bundles.bundlePaths(appRoot);

  if (!state.markerIsFresh(appRoot, files)) {
    info("patch state stale (Cursor was updated?) — re-applying");
    const rc = cmdApply({ skipSeed: true });
    if (rc !== 0) warn("re-apply failed; launching anyway");
  }

  // Seed before exec so the very first AvailableModels render already has the
  // right catalog. This is what prevents the picker from showing only Auto.
  seed.reportSeed(seed.seedCatalog());

  const binary = cursorBinary(appRoot);
  if (!binary) {
    fail(`cursor launcher not found next to ${appRoot}`);
    return 1;
  }

  const env = { ...process.env };
  delete env.CURSOR_API_BASE_URL;
  delete env.CURSOR_WEBSITE_URL;

  // Detach so the launcher can exit and Cursor keeps running: a desktop entry
  // should not stay alive as Cursor's parent.
  const { spawn } = await import("node:child_process");
  const child = spawn(binary, args.forward ?? [], { env, stdio: "ignore", detached: true });
  child.unref();
  return 0;
}

export function cmdUpdate(args = {}) {
  const installDir = args.installDir ? path.resolve(args.installDir) : defaultInstallDir();

  if (args.rollback) {
    if (update.rollback(installDir)) {
      ok("rolled back to the previous tree");
      return 0;
    }
    fail("no previous tree to roll back to");
    return 1;
  }

  return update.run({
    appimage: args.appimage,
    installDir,
    keepOld: !args.dropOld,
  });
}

const RULE = `# Agent rule: one file per Write call

The Write tool replaces a whole file. When several files are written in one turn,
issue one Write call per file. Never put two files' contents into a single
\`contents\` field.

Symptoms when this is ignored: a manifest ends up containing JavaScript, a source
file ends up containing JSON, and no error is reported because the bytes were
written verbatim.
`;

/**
 * Presence check uses a phrase from the rule body, not the heading: a project may
 * restate the rule under its own heading, and that still counts as present.
 */
const RULE_SENTINEL = "Never put two files' contents into a single";

export function cmdRule(args = {}) {
  if (args.write) {
    const target = path.resolve(args.write);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    if (existing.includes(RULE_SENTINEL)) {
      ok(`${target} already covers the one-file-per-Write rule`);
      return 0;
    }
    const separator = existing && !existing.endsWith("\n\n") ? "\n\n" : "";
    fs.writeFileSync(target, existing + separator + RULE);
    ok(`appended the rule to ${target}`);
    return 0;
  }
  process.stdout.write(RULE);
  return 0;
}

// ----------------------------------------------------------------------- usage

const USAGE = `cursor-byok ${VERSION} — keep bring-your-own-key working in Cursor

Usage:
  cursor-byok <command> [options]

Commands:
  apply                 patch an existing install (idempotent)
    --dry-run           report what would change without writing
    --skip-installer    do not run the @cometix/ccursor installer
    --skip-seed         do not seed the model catalog
  status                report what is currently in effect
  doctor                diagnose a broken setup
  revert                restore the bundles Cursor shipped
  run [cursor flags]    seed, re-apply if needed, then launch Cursor
  update                extract, patch and swap in a new AppImage
    --appimage <path>   AppImage to install (default ~/Applications/Cursor.AppImage)
    --install-dir <dir> where the patched tree lives
    --drop-old          delete the previous tree after a successful swap
    --rollback          restore the previous tree and exit
  rule                  print the agent rule that keeps Write calls sane
    --write <path>      append it to a file (e.g. AGENTS.md)

Environment:
  CURSOR_APP_ROOT       point at resources/app when Cursor is installed elsewhere
  CURSOR_BYOK_STATE     override ~/.cursor-byok-patch
  NO_COLOR              disable colored output
`;

const FLAGS = {
  "--dry-run": "dryRun",
  "--skip-installer": "skipInstaller",
  "--skip-seed": "skipSeed",
  "--drop-old": "dropOld",
  "--rollback": "rollback",
};

export function parseArgs(argv) {
  const args = { forward: [] };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token in FLAGS) {
      args[FLAGS[token]] = true;
    } else if (token === "--appimage" || token === "--install-dir" || token === "--write") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${token} needs a value`);
      args[token === "--appimage" ? "appimage" : token === "--install-dir" ? "installDir" : "write"] = value;
    } else if (token === "--version" || token === "-v") {
      args.version = true;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      positional.push(token);
    }
  }

  args.command = positional.shift();
  // Anything left after `run` belongs to Cursor itself.
  if (args.command === "run") args.forward = positional;
  else if (positional.length) throw new Error(`unrecognized arguments: ${positional.join(" ")}`);

  return args;
}

export async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fail(error.message);
    process.stderr.write(USAGE);
    return 2;
  }

  if (args.version) {
    console.log(`cursor-byok ${VERSION}`);
    return 0;
  }
  if (args.help || !args.command) {
    process.stdout.write(USAGE);
    return args.command ? 0 : 2;
  }

  switch (args.command) {
    case "apply":
      return cmdApply(args);
    case "status":
      return cmdStatus(args);
    case "doctor":
      return cmdDoctor(args);
    case "revert":
      return cmdRevert(args);
    case "run":
      return cmdRun(args);
    case "update":
      return cmdUpdate(args);
    case "rule":
      return cmdRule(args);
    default:
      fail(`unknown command: ${args.command}`);
      process.stderr.write(USAGE);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
