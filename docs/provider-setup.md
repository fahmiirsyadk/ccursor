# Provider setup

`~/.ccursor/providers.json` defines what the local BYOK server exposes to Cursor.
The file is read by the extension, hot-reloaded on change, and served through
`AvailableModels`.

## Shape

```json
{
  "$schemaVersion": 1,
  "providers": [
    {
      "id": "string, unique",
      "name": "string, shown in logs",
      "type": "anthropic | openai-chat | openai-responses | gemini",
      "baseUrl": "https://.../v1",
      "auth": { "kind": "apiKey", "value": "sk-..." },
      "proxyUrl": "optional, for outbound proxies",
      "headers": { "optional": "extra request headers" },
      "models": []
    }
  ]
}
```

## Model fields

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Identifier Cursor stores and sends in the picker. Must be unique across providers. |
| `apiModel` | no | Name sent upstream. Defaults to `id`. Set this when your gateway expects a different name. |
| `displayName` | no | Label in the picker. Defaults to `id`. |
| `contextTokenLimit` | strongly recommended | Drives the context meter and compaction. Wrong values cause bad truncation. |
| `maxOutputTokens` | no | Defaults to 8192. |
| `supportsImages` | no | Defaults to true. Set false for text-only models. |
| `supportsAgent` | no | Defaults to true. |
| `supportsCmdK` | no | Defaults to true. |
| `thinking` | no | Enables reasoning controls in the picker. |
| `thinkingLevel` | no | `low`, `medium`, `high` when `thinking` is on. |
| `thinkingBudgetTokens` | no | Explicit budget instead of a level. |
| `fastMode` | no | Requests priority service tier where supported. |
| `defaultOn` | no | Pre-selects the model. |

## Choosing `type`

| `type` | Use when your endpoint speaks |
|---|---|
| `openai-chat` | `POST /chat/completions` with SSE streaming — most gateways, vLLM, LiteLLM, Ollama, OpenRouter |
| `openai-responses` | `POST /responses` |
| `anthropic` | `POST /messages` |
| `gemini` | Google Generative Language API |

If you are unsure, use `openai-chat`. It covers the widest range of [OI]-compatible
servers.

## Example: [OI]-compatible gateway

```json
{
  "$schemaVersion": 1,
  "providers": [
    {
      "id": "gateway",
      "name": "Gateway",
      "type": "openai-chat",
      "baseUrl": "https://api.example.com/v1",
      "auth": { "kind": "apiKey", "value": "sk-..." },
      "models": [
        {
          "id": "vendor/model-large",
          "apiModel": "vendor/model-large",
          "displayName": "Model Large",
          "contextTokenLimit": 200000,
          "maxOutputTokens": 16384,
          "supportsImages": true,
          "thinking": true,
          "thinkingLevel": "medium",
          "defaultOn": true
        }
      ]
    }
  ]
}
```

## Example: local server

The endpoint must be reachable **from the extension host**, which runs on your
machine, so a loopback address works here:

```json
{
  "$schemaVersion": 1,
  "providers": [
    {
      "id": "local",
      "name": "Local",
      "type": "openai-chat",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "auth": { "kind": "apiKey", "value": "not-needed" },
      "models": [
        {
          "id": "qwen3-coder",
          "displayName": "Qwen3 Coder",
          "contextTokenLimit": 131072,
          "supportsImages": false
        }
      ]
    }
  ]
}
```

## Always add the `default` alias

Cursor sends `modelId: "default"` whenever **Auto** is selected, and a freshly
created composer starts on Auto. If `providers.json` has no model with that id, the
BYOK server rejects the turn:

```
Model default was not found in ~/.cursor/providers.json.
Open the Cursor++ side panel -> Providers, add the model, then try again.
```

Add the alias with one command:

```bash
cursor-byok alias
```

Which appends:

```json
{
  "id": "default",
  "apiModel": "vendor/model-large",
  "displayName": "Auto (-> Model Large)",
  "defaultOn": false
}
```

`apiModel` points at your primary model, so Auto routes to it. The catalog builder
skips `default`, so the picker still shows a single Auto entry rather than a
duplicate.

The extension hot-reloads `providers.json` within about two seconds, so no restart
is needed.

## Verifying

Test the endpoint before blaming Cursor:

```bash
curl -sS https://api.example.com/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"vendor/model-large","stream":true,
       "messages":[{"role":"user","content":"reply with ok"}],"max_tokens":8}'
```

Then confirm the server serves your catalog:

```bash
curl -sS -X POST http://127.0.0.1:39831/aiserver.v1.AiService/AvailableModels \
  -H 'content-type: application/json' -d '{}'
```

Your model ids should appear in `modelNames`.

## Tool calling

Agent mode depends on the model supporting tool calls. If the model streams text
but never invokes a tool, check the provider's capability metadata — the adapter
only offers tools the model advertises. Models without tool support work in chat
mode but cannot drive the agent loop.
