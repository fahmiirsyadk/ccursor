# Tool calling

A BYOK agent loop is only as good as the tool calls the model produces. Two
failures are common, and neither is a transport bug.

---

## A file ends up containing another file's contents

**Symptom**

`package.json` contains JavaScript. A `.js` file starts with `{`. No error is
reported — the tool result says `completed`.

**What actually happened**

The model issued a single `Write` call whose `contents` field held two files:

```text
chars 0-856     {"name": "cursor-byok", ...}      <- the manifest
chars 857-4300  /** Filesystem layout ... */      <- the next module
```

The second file is never created. Cursor's `Write` maps to an internal
`editToolCall` with `writeArgs`, which forwards the string verbatim:

```js
buildExecArgs: (t, e) => {
  const path = Xe(t.path);
  const text = gEe(typeof t.contents === "string" ? t.contents : "");
  return { path, fileText: text, streamContent: text, encodingHint: "utf8", toolCallId: e };
}
```

There is no content validation, so a concatenated blob is written as-is and the
call still reports success.

**Verified not a transport issue**

Replaying the adapter's exact accumulation logic against the endpoint:

| Test | Result |
|---|---|
| 2 parallel `Write` calls | 2 calls, correct ids and paths |
| 3 parallel calls, 5.2 KB payload | 3 calls, paths correct, no mixing |
| Delta ordering | `0x100 -> 1x100 -> 2x100`, no interleaving |
| Deltas arriving without an id | 0 |
| Same porting task in a clean context | 2 separate calls, correct |

The adapter keys its accumulator by `tool_call.index` and appends
`function.arguments` per index, which is correct. Interleaved deltas are handled.

**Why the model does it**

Instruction-following degrades under long tool-only stretches. In the observed
run:

```text
26 consecutive rounds with textChars = 0, stop = tool_use
final round: 1488 events, 64s, then two files batched into one call
```

The built-in `Write` description never says "one file per call" — it only warns
about overwriting and about creating documentation files unprompted.

**Mitigation**

Add the rule to your project so it applies to every session:

```bash
cursor-byok rule --write AGENTS.md
```

Which appends:

> The Write tool replaces a whole file. When several files are written in one turn,
> issue one Write call per file. Never put two files' contents into a single
> `contents` field.

Bounding the turn also helps. Long unbounded loops are what push a model into
batching:

> Do the task. At most N tool calls. After that, stop calling tools and write the
> result.

**Recovery**

Check for the symptom before committing:

```bash
node -e 'JSON.parse(require("fs").readFileSync("package.json","utf8"))'   # manifest
head -c 40 src/paths.js                                                    # source
```

If a manifest fails to parse or a source file starts with `{`, the two files were
merged. Split them at the boundary and re-run.

---

## The model never stops calling tools

**Symptom**

"Planning next moves" repeats indefinitely. The status line shows round after
round; no answer is produced.

**Cause**

Model behaviour, not transport. Some models — `deepseek-v4.1-flash` among them —
keep exploring instead of concluding.

**Fix**

Bound the prompt explicitly. Measured effect on the same repository:

| Prompt | Rounds | Outcome |
|---|---|---|
| "analyse this codebase" | 26 tool rounds, no text | never concluded |
| "max 6 tool calls, then a 5-bullet summary" | 4 tool rounds + 1 answer | 2.3 KB summary in 77s |

---

## Chat works but agent mode does not

Check the provider's capability metadata. The adapter only offers tools the model
advertises; a model without tool-call support answers in chat mode but cannot drive
the agent loop. `docs/provider-setup.md` covers the fields.
