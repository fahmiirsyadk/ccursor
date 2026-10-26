# Security and scope

Read this before installing.

## What this tool does

It modifies the JavaScript bundle of a desktop application you already have
installed, so that a feature you configured (your own API key) keeps working. It
writes only inside the Cursor installation directory and two config files in your
home directory. It never phones home, never collects telemetry, and makes no
network requests of its own.

## What it does not do

- It does not grant access to Cursor's paid models, quotas, or cloud agents.
- It does not bypass authentication for anything you would otherwise pay Cursor for.
- It does not touch your API keys beyond leaving them in the config file the
  extension already reads.

You still pay your model provider for every token. If your goal is free access to a
paid service, this is not that.

## Terms of service

Patching a client application is generally prohibited by commercial terms of
service. Cursor's terms are theirs to set and may change. This is a personal-use
tool published for people who want to run their own models through a client they
already use; whether that is acceptable under your agreement is your call and your
responsibility.

## Third-party code

The BYOK extension (`@cometix/ccursor`) is a 17 MB VSIX containing 4.4 MB of minified
JavaScript and eight native binaries. It receives your API key and your source code.
None of that can be reviewed, so it is treated as untrusted:

- the tarball is downloaded once, its SHA-512 verified against a hash pinned in this
  repository, and the extracted copy re-verified on every run (`src/vendor.js`)
- a mismatch fails loudly instead of installing something else
- `cursor-byok apply` never falls back to `npx`, which would re-fetch unverified bytes

Replacing that package with our own code is in progress. The protobuf schema turned
out to be recoverable from Cursor's own bundle, which makes it feasible; see
[docs/reimplementation.md](docs/reimplementation.md).

The installer also patches Cursor's extension-signature check globally, which
disables integrity verification for ten built-in extensions where we modify one.

## Trust model

- Everything runs locally. The code is short enough to read in one sitting.
- The one external dependency is `@cometix/ccursor`, invoked through `npx` and
  pinned to `0.0.15`. That package injects the renderer hook and the HTTP/1.1
  router. If you would rather not run it, use `--skip-installer` and install the
  hook yourself; `doctor` will report the router as missing.
- Patches are structural and validated. When the expected code shape is absent, the
  tool writes nothing and tells you, instead of guessing.
- Every write is preceded by a snapshot, and `revert` restores the pristine
  baseline captured before the first write.

## Data handling

With BYOK enabled, prompts, code context, and tool results are sent to the endpoint
you configured, under that provider's terms. Cursor's zero-data-retention guarantee
does not extend to requests made with your own key.

## Reporting problems

Include the Cursor version (`cursor-byok status`), the failing command, and the
output of `cursor-byok doctor`. Do not paste API keys — redact anything that looks
like a token.
