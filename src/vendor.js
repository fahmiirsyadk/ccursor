/**
 * Vendored upstream installer.
 *
 * We drive `@cometix/ccursor` because reimplementing it means reimplementing
 * Cursor's entire AI backend contract (see docs/dependencies.md). What we can do is
 * remove the trust assumptions around *fetching* it:
 *
 *   npx -y @cometix/ccursor@0.0.15 install
 *     - resolves from the registry every run
 *     - no verification that the bytes match what we audited
 *     - a registry or CDN compromise is invisible
 *
 * Instead: download the tarball once, verify its SHA-512 against a hash pinned in
 * this repo, extract it, and run the extracted CLI. The audited bytes are the bytes
 * that run, and a mismatch fails loudly instead of silently installing something
 * else.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { stateDir } from "./paths.js";
import { detail, fail, info, ok, warn } from "./ui.js";

/** Pinned upstream release. Update both fields together, after re-auditing. */
export const PINNED = {
  package: "@cometix/ccursor",
  version: "0.0.15",
  // SHA-512 of cometix-ccursor-0.0.15.tgz, base64, as published by npm.
  integrity:
    "sha512-uXCsK2ZQUp4tMrRFoHBkqVF0NENEkAnH+sCcwky5goe2JTnrPFcAkBGJq/IV3Jf7O8MH+CEmiheLm2ByMueKdg==",
  tarball: "https://registry.npmjs.org/@cometix/ccursor/-/ccursor-0.0.15.tgz",
};

const vendorDir = () => path.join(stateDir(), "vendor");
const archivePath = () => path.join(vendorDir(), `ccursor-${PINNED.version}.tgz`);
const manifestPath = () => path.join(vendorDir(), "manifest.json");
const cliPath = () =>
  path.join(vendorDir(), `package-${PINNED.version}`, "package", "dist", "cli.cjs");

/** SHA-512 of a file, base64, matching npm's integrity format. */
function sha512(file) {
  return "sha512-" + crypto.createHash("sha512").update(fs.readFileSync(file)).digest("base64");
}

function verify(file) {
  const actual = sha512(file);
  if (actual !== PINNED.integrity) {
    throw new Error(
      `integrity mismatch for ${PINNED.package}@${PINNED.version}\n` +
        `  expected ${PINNED.integrity}\n` +
        `  actual   ${actual}\n` +
        "Refusing to install. If this is a deliberate upgrade, re-audit the tarball " +
        "and update PINNED in src/vendor.js.",
    );
  }
  return actual;
}

/** Download the pinned tarball and verify it. Returns the local archive path. */
async function download() {
  fs.mkdirSync(vendorDir(), { recursive: true });
  const target = archivePath();

  info(`downloading ${PINNED.package}@${PINNED.version}`);
  const res = await fetch(PINNED.tarball, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`download failed: http ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buffer);

  const digest = verify(target);
  fs.writeFileSync(
    manifestPath(),
    JSON.stringify(
      { package: PINNED.package, version: PINNED.version, integrity: digest, verifiedAt: Date.now() },
      null,
      2,
    ) + "\n",
  );
  detail(`verified ${digest.slice(0, 24)}…`);
  return target;
}

function extract(archive) {
  const dest = path.join(vendorDir(), `package-${PINNED.version}`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const result = spawnSync("tar", ["xzf", archive, "-C", dest], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`extract failed: ${(result.stderr || "").trim() || result.status}`);
  }
  if (!fs.existsSync(cliPath())) throw new Error(`unexpected archive layout: ${cliPath()}`);
  return dest;
}

/**
 * Ensure a verified, extracted copy exists. Returns the CLI path.
 * Re-verifies the archive on every call, so a tampered cache is caught too.
 */
export async function ensureVendored({ refresh = false } = {}) {
  const cli = cliPath();

  if (!refresh && fs.existsSync(cli) && fs.existsSync(archivePath())) {
    try {
      verify(archivePath());
      return cli;
    } catch (error) {
      warn(error.message);
      detail("re-downloading");
    }
  }

  const archive = await download();
  extract(archive);
  ok(`vendored ${PINNED.package}@${PINNED.version}`);
  return cli;
}

/**
 * Run the vendored installer against an app root.
 * @returns {boolean} success
 */
export async function install(appRoot, { quiet = false } = {}) {
  let cli;
  try {
    cli = await ensureVendored();
  } catch (error) {
    fail(error.message);
    return false;
  }

  if (!quiet) info(`installing ${PINNED.package}@${PINNED.version} (vendored)`);

  const result = spawnSync(process.execPath, [cli, "install"], {
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, CCURSOR_CURSOR_ROOT: appRoot },
  });

  if (result.error) {
    fail(`could not run the installer: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    fail("installer failed");
    for (const line of (result.stderr || result.stdout || "").split("\n").filter(Boolean).slice(-6)) {
      detail(line);
    }
    return false;
  }

  if (!quiet) {
    for (const line of (result.stdout || "").split("\n").filter(Boolean).slice(-3)) detail(line);
    ok("hook and router installed");
  }
  return true;
}

/** Report the pinned version and whether a verified copy is cached. */
export function describe() {
  const cached = fs.existsSync(cliPath());
  let state = "not vendored";
  if (cached) {
    try {
      verify(archivePath());
      state = "vendored + verified";
    } catch {
      state = "vendored but FAILED verification";
    }
  }
  return `${PINNED.package}@${PINNED.version} (${state})`;
}
