# Security and scope

Read this before installing.

## What this tool does

It modifies the JavaScript bundle of a desktop application you already have
installed, so that a feature you configured (your own API key) keeps working. It
writes only inside the Cursor installation directory, one settings file, Cursor's
own model state, and its own state directory. It never phones home, never collects
telemetry, and makes no network requests of its own. The only outbound requests are
the model calls you configured, made by the local server.

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

There is none. Every component is in this repository:

| Component | What it does |
|---|---|
| `src/router.js` | Diverts Cursor's AI calls to the local server |
| `src/inject.js` | Prepends that router to Cursor's own extension hosts |
| `src/server.js` | Answers the RPCs Cursor makes |
| `src/agent/` | One agent turn: request, provider call, tool loop |
| `src/prompt/` | Reads Cursor's agent prompt out of its own bundled extension |
| `src/proto/client-schema.js` | Reads Cursor's schema out of its own client |

The one runtime dependency is [`protobufjs`](https://www.npmjs.com/package/protobufjs),
used to encode and decode protobuf. It is a well-known library with no native code.

Nothing is fetched at run time, no tarball is downloaded, and no traffic is sent to
Cursor's backend. The protocol schema and the agent prompt are read from the
installed app; the rest of the prompt is what the client sends with the request.

### What is still modified in Cursor

- two workbench bundles, to neutralise the guards that switch BYOK off
- two of Cursor's own extension hosts, to prepend the router
- `extensionHostProcess.js`, to drop those two extensions from the expected-hash
  table so the check still verifies everything else
- `settings.json`, to force HTTP/1.1
- `state.vscdb`, to seed your models into the picker

Each write is preceded by a snapshot, and `revert` restores the pristine baseline,
removes the router from the extension hosts, and re-enables the hash check.

## Trust model

- Everything runs locally. The code is short enough to read in one sitting.
- The only external dependency is `protobufjs`, for protobuf encoding.
- The prompt and the protocol schema are read from your installed Cursor, not
  written by hand, so there is no frozen copy to drift or to trust blindly.
- No process contacts Cursor's backend on your behalf. Telemetry hosts are answered
  locally and dropped.
- Patches are structural and validated. When the expected code shape is absent, the
  tool writes nothing and tells you, instead of guessing.
- Every write is preceded by a snapshot, and `revert` restores the pristine
  baseline captured before the first write, including the extension-host file whose
  hash check we narrow.

## Data handling

With BYOK enabled, prompts, code context, and tool results are sent to the endpoint
you configured, under that provider's terms. Cursor's zero-data-retention guarantee
does not extend to requests made with your own key.

## Reporting problems

Include the Cursor version (`cursor-byok status`), the failing command, and the
output of `cursor-byok doctor`. Do not paste API keys — redact anything that looks
like a token.
