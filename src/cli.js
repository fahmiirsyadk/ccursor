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
 *   serve    run the local BYOK server in the foreground
 *   stop     stop the background server
 *   update   extract, patch and swap in a new AppImage
 *   rule     print the agent rule that keeps tool calls sane
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as bundles from "./bundles.js";
import * as ccursor from "./ccursor.js";
import * as daemon from "./daemon.js";
import * as extensionHost from "./extensionHost.js";
import * as inject from "./inject.js";
import * as routes from "./routes.js";
import * as schemaCache from "./proto/cache.js";
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
  writeJson,
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

// ------------------------------------------------------------------- commands

export async function cmdApply(args = {}) {
  const found = requireInstall();
  if (!found) return 1;

  const { appRoot, version } = found;
  info(`app root: ${appRoot}`);
  detail(`version ${version ?? "unknown"}`);

  // The extension is the one thing we do not ship: it is where the protobuf schema
  // lives, and it is a large third-party artifact. Everything else below is ours.
  if (args.skipInstaller) {
    detail("skipping extension install (--skip-installer)");
  } else if (!(await ccursor.ensureExtension(appRoot))) {
    warn("BYOK extension unavailable; the server will fall back to the cached schema");
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

  // Cache the schema first: routes and the server both depend on it. Cursor's own
  // client is the better source, so it is tried first and the extension is only a
  // fallback for an install where the workbench bundle cannot be read.
  const workbench = path.join(appRoot, "out/vs/workbench/workbench.desktop.main.js");
  const extensionJs = ccursor.schemaSource(appRoot);
  let cached = false;

  if (fs.existsSync(workbench)) {
    try {
      const result = schemaCache.saveFromClient(workbench);
      ok(
        `schema: ${result.messages} messages, ${result.methods} methods from Cursor's client` +
          (result.reused ? " (already cached)" : ""),
      );
      cached = true;
    } catch (error) {
      warn(`client schema not readable: ${error.message}`);
    }
  }

  if (!cached && extensionJs) {
    try {
      const result = schemaCache.saveFromExtension(extensionJs);
      warn("using the BYOK extension's schema, which may be older than Cursor's client");
      ok(`schema: ${result.messages} descriptors${result.reused ? " (already cached)" : ""}`);
      cached = true;
    } catch (error) {
      warn(`schema not cached: ${error.message}`);
    }
  }

  if (!cached) warn("no schema cached; run apply again after installing Cursor");

  settings.ensureRoutes({ workbench, extension: extensionJs });

  // Replace whatever router is in the extension hosts with ours.
  const injected = inject.injectAll(appRoot, routes.routesPath());
  for (const entry of injected) {
    if (entry.status === "missing") warn(`${entry.label}: extension host not found`);
    else ok(`${entry.label}: router ${entry.status === "already" ? "already present" : "injected"}`);
  }

  // Narrow the extension hash check: drop only the extensions we modify, and undo
  // any broad `if(!1)` a previous installer left behind.
  try {
    const verification = extensionHost.patchVerification(appRoot);
    if (verification.exempted.length > 0) {
      ok(`extension verification: exempted ${verification.exempted.join(", ")}`);
    }
    if (verification.restored) ok("extension verification: check restored for other extensions");
    if (!verification.changed) detail("extension verification: already correct");
  } catch (error) {
    warn(`extension verification not patched: ${error.message}`);
  }

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
  console.log(`  BYOK extension      : ${ext ? "installed" : "MISSING (schema cache only)"}`);
  console.log(`  router always-local : ${alwaysLocal ? "yes" : "NO"}`);
  console.log(`  router agent-host   : ${agentHost ? "yes" : "NO"}`);

  const verification = extensionHost.describe(appRoot);
  console.log(
    `  extension hashes    : ${
      !verification.table
        ? "table not found"
        : verification.disabled
          ? "NOT VERIFIED (broad bypass)"
          : `${verification.verified} verified, ${verification.exempt.length} ours unverified`
    }`,
  );

  const schema = schemaCache.describe();
  console.log(
    `  schema cache        : ${
      !schema.present
        ? "MISSING"
        : schema.source === "client"
          ? `${schema.stats?.messages} messages from Cursor's client`
          : `${schema.stats?.messages} descriptors from the extension (older)`
    }`,
  );

  heading("configuration");
  const cfg = readJsonOr(settingsFile());
  console.log(`  disableHttp2        : ${cfg?.[settings.DISABLE_HTTP2] ?? null}`);
  const routes = readJsonOr(routesFile());
  const port = routes?.server?.port ?? null;
  console.log(`  routes.json port    : ${port}`);
  const ruleCount = Array.isArray(routes?.redirect) ? routes.redirect.length : 0;
  console.log(`  redirect rules      : ${ruleCount}`);
  console.log(`  providers           : ${settings.describeProviders()}`);
  console.log(`  BYOK server         : ${await daemon.describe(port ?? DEFAULT_PORT)}`);
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

  const verification = extensionHost.describe(appRoot);
  if (verification.disabled) {
    problems.push("extension hash check is disabled wholesale -> run apply to narrow it");
  } else if (verification.exempt.length === 0) {
    problems.push("modified extension is still hash-verified -> run apply");
  }

  const schema = schemaCache.describe();
  if (!schema.present) {
    problems.push("protobuf schema not cached -> run apply");
  } else if (schema.source !== "client") {
    problems.push(
      "schema came from the BYOK extension, which is older than Cursor's client -> run apply",
    );
  }

  const routes = readJsonOr(routesFile());
  const port = routes?.server?.port;
  if (!port) {
    problems.push("routes.json missing -> run apply");
  } else if (!Array.isArray(routes.redirect) || routes.redirect.length === 0) {
    problems.push("routes.json has no redirect rules -> run apply");
  } else if ((await daemon.health(port)) !== "byok") {
    problems.push(`BYOK server not answering as ours on port ${port} -> run 'cursor-byok run'`);
  }

  const providers = settings.describeProviders();
  if (["missing", "empty", "malformed"].includes(providers)) {
    problems.push(`${providersFile()} has no providers -> add one before sending a message`);
  } else if (!settings.hasDefaultAlias()) {
    problems.push(
      "providers.json has no \"default\" alias -> selecting Auto fails with " +
        "\"Model default was not found\". Run 'cursor-byok alias'.",
    );
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
    const rc = await cmdApply({ skipSeed: true });
    if (rc !== 0) warn("re-apply failed; launching anyway");
  }

  // Seed before exec so the very first AvailableModels render already has the
  // right catalog. This is what prevents the picker from showing only Auto.
  seed.reportSeed(seed.seedCatalog());

  // The server must own the port before Cursor boots: the BYOK extension probes
  // it and steps aside when something answers as ours. Starting after Cursor
  // loses the race and the extension serves instead.
  const server = await daemon.ensureServer({ appRoot });
  if (server === "started") detail("local server started");
  else if (server === "already-running") detail("local server already running");
  else if (server === "port-taken") {
    // The port is held by a BYOK server that is not ours — almost always the
    // extension inside a Cursor that is already open. Launching now would start a
    // second window and the wrong server would keep serving.
    fail("Cursor is already running, so the port belongs to its extension");
    detail("quit Cursor, then run this again — the local server must win the port");
    return 1;
  }

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

/** Run the server in the foreground. */
export async function cmdServe(args = {}) {
  const appRoot = args.app ? path.resolve(args.app) : requireInstall()?.appRoot;
  if (!appRoot) return 1;

  const port = args.port ? Number(args.port) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`invalid port: ${args.port}`);
    return 1;
  }

  const { start } = await import("./server.js");
  const instance = await start({ appRoot, port });

  // A terminal Ctrl-C and a SIGTERM from `stop` should both close cleanly.
  const shutdown = async () => {
    await instance.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  info(`server running — ${daemon.logPath()} for the background copy`);
  return new Promise(() => {});
}

/** Stop the background server. */
export async function cmdStop() {
  return daemon.stopServer() ? 0 : 1;
}

export async function cmdUpdate(args = {}) {
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
  // update.run is async; the caller awaits via main().
}

/**
 * Add a `default` alias so Cursor's Auto model resolves.
 *
 * Cursor sends modelId "default" whenever Auto is selected, and a freshly created
 * composer starts on Auto. Without an entry with that id the BYOK server rejects
 * the turn with "Model default was not found in providers.json".
 *
 * The alias is an alias, not a pickable model: it points at the primary model via
 * apiModel, and the catalog builder skips it so the picker does not show a second
 * Auto.
 */
export function cmdAlias(args = {}) {
  const file = providersFile();
  const cfg = readJsonOr(file);
  if (!cfg || !Array.isArray(cfg.providers) || cfg.providers.length === 0) {
    fail(`${file} has no providers; add one first`);
    return 1;
  }

  const provider = cfg.providers[0];
  const models = Array.isArray(provider.models) ? provider.models : [];
  const primary = models.find((m) => m.id !== "default");
  if (!primary) {
    fail(`${file}: provider "${provider.id}" has no model to alias`);
    return 1;
  }

  if (models.some((m) => m.id === "default")) {
    ok(`alias already present -> ${models.find((m) => m.id === "default").apiModel}`);
    return 0;
  }

  const alias = {
    id: "default",
    apiModel: primary.apiModel ?? primary.id,
    displayName: `Auto (→ ${primary.displayName ?? primary.id})`,
    contextTokenLimit: primary.contextTokenLimit ?? 200000,
    maxOutputTokens: primary.maxOutputTokens ?? 16384,
    supportsImages: primary.supportsImages !== false,
    supportsAgent: true,
    supportsCmdK: true,
    thinking: primary.thinking === true,
    defaultOn: false,
  };

  if (args.dryRun) {
    ok(`would add alias: default -> ${alias.apiModel}`);
    return 0;
  }

  provider.models = [...models, alias];
  writeJson(file, cfg);
  ok(`added alias: default -> ${alias.apiModel}`);
  detail("hot-reloaded by the extension within ~2s; no restart needed");
  return 0;
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
  serve                 run the local BYOK server in the foreground
    --port <n>          listen on a different port (default 39831)
    --app <dir>         point at resources/app
  stop                  stop the background server
  update                extract, patch and swap in a new AppImage
    --appimage <path>   AppImage to install (default ~/Applications/Cursor.AppImage)
    --install-dir <dir> where the patched tree lives
    --drop-old          delete the previous tree after a successful swap
    --rollback          restore the previous tree and exit
  alias                 map Cursor's Auto model id ("default") to your primary model
    --dry-run           report what would change without writing
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

const VALUE_FLAGS = {
  "--appimage": "appimage",
  "--install-dir": "installDir",
  "--write": "write",
  "--app": "app",
  "--port": "port",
};

const COMMANDS = [
  "apply",
  "status",
  "doctor",
  "revert",
  "run",
  "serve",
  "stop",
  "update",
  "rule",
  "alias",
];

export function parseArgs(argv) {
  const args = { forward: [] };

  // Locate the subcommand first. Anything before it is a global flag; anything
  // after it belongs to that subcommand.
  const commandAt = argv.findIndex((token) => COMMANDS.includes(token));
  if (commandAt === -1) {
    for (const token of argv) {
      if (token === "--version" || token === "-v") args.version = true;
      else if (token === "--help" || token === "-h") args.help = true;
      else if (token.startsWith("-")) throw new Error(`unrecognized arguments: ${token}`);
      else throw new Error(`unknown command: ${token}`);
    }
    return args;
  }

  args.command = argv[commandAt];
  const leading = argv.slice(0, commandAt);
  const trailing = argv.slice(commandAt + 1);

  for (const token of leading) {
    if (token === "--version" || token === "-v") args.version = true;
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`unrecognized arguments: ${token}`);
  }

  // `run` takes no options of its own: everything after it is Cursor's, and
  // Cursor's flag set is not ours to enumerate.
  if (args.command === "run") {
    args.forward = trailing;
    return args;
  }

  for (let i = 0; i < trailing.length; i += 1) {
    const token = trailing[i];
    if (token in FLAGS) {
      args[FLAGS[token]] = true;
    } else if (token in VALUE_FLAGS) {
      const value = trailing[++i];
      if (value === undefined) throw new Error(`${token} needs a value`);
      args[VALUE_FLAGS[token]] = value;
    } else if (token === "--version" || token === "-v") {
      args.version = true;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      throw new Error(`unrecognized arguments: ${token}`);
    }
  }

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
    case "serve":
      return cmdServe(args);
    case "stop":
      return cmdStop(args);
    case "update":
      return cmdUpdate(args);
    case "rule":
      return cmdRule(args);
    case "alias":
      return cmdAlias(args);
    default:
      fail(`unknown command: ${args.command}`);
      process.stderr.write(USAGE);
      return 2;
  }
}

/**
 * Run only when this file is the entry point.
 *
 * Compare real paths on both sides: `npm link` (documented in the README) puts a
 * symlink in the global bin directory, and path.resolve() does not follow it. A
 * plain comparison made the CLI exit 0 without doing anything, which looks like
 * success. fileURLToPath also handles spaces and percent-encoding, which
 * `new URL(...).pathname` does not.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then((code) => process.exit(code));
}
