# Provider setup

There are two ways to tell the server where your models are. Most people need
neither file.

## The short way: Cursor's own settings

Add your model and API key in **Settings → Models**. Cursor stores the model list and
the base URL in its own state, and attaches the key to each turn. The server reads
all three from there:

| What | Where it comes from |
|---|---|
| model list | Cursor's `availableAPIKeyModels` / `availableDefaultModels2` |
| base URL | Cursor's `openAIBaseUrl` |
| API key | the turn itself (`requested_model.api_key_credentials`) |

Nothing in `~/.cursor-byok-patch/` is required. `cursor-byok status` prints which
source is in use:

```
  models              : 3 (Cursor's settings)
```

If Cursor does not pass the key along with a turn, put it in one line instead:

```bash
printf '%s\n' 'sk-...' > ~/.cursor-byok-patch/apiKey
```

## The long way: `providers.json`

This file wins when it names the same model, and it is the only way to express what
Cursor's UI cannot: an `apiModel` that differs from the id, several endpoints at
once, or a gateway Cursor cannot verify.

The server reads it on every turn and serves it through `AvailableModels`, so an edit
takes effect without a restart.

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

If you are unsure, use `openai-chat`. It covers the widest range of OpenAI-compatible
servers.

## Example: OpenAI-compatible gateway

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

The endpoint must be reachable **from the machine running Cursor**, so a loopback
address works here:

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

## Auto

Cursor sends `modelId: "default"` whenever **Auto** is selected, and a fresh composer
starts on Auto.

With Cursor's own model list, Auto resolves to the first model in that list — no setup
needed. With `providers.json`, either list a `default` entry or let it fall back the
same way. To pin Auto to a specific model:

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

The server reads `providers.json` on every turn, so no restart is needed.

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

Agent mode depends on the model supporting tool calls. The full catalog is offered
to every model, since there is no reliable way to ask a provider whether it supports
them. If a model streams text but never invokes a tool, that model does not do tool
calling: it works in chat mode but cannot drive the agent loop. Choose a model that
does.
