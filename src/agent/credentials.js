/**
 * The provider, taken from the run request itself.
 *
 * Cursor already knows how to add a model and a key: its own "Add Models" dialog
 * stores the base URL and the model list, and it attaches the credentials to the
 * turn it sends. That makes a separate provider file redundant for the common case,
 * so it becomes optional rather than required.
 *
 * Nothing is guessed: when the request carries no credentials, this returns null and
 * the caller falls back to a stored key and then to `providers.json`.
 */

import fs from "node:fs";

import { apiKeyFile } from "../paths.js";

/**
 * Which API the base URL speaks.
 *
 * Only two shapes are implemented, so an unknown host is treated as the
 * [OI]-compatible one, which is what Cursor's own BYOK setting produces.
 *
 * @param {string} baseUrl
 * @returns {"openai-chat"|"anthropic"}
 */
export function inferType(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes("anthropic")) return "anthropic";
  } catch {
    // A malformed URL is not worth failing over: the provider call reports it.
  }
  return "openai-chat";
}

/**
 * Credentials the client attached to this turn.
 *
 * Two fields can carry them, and the request-level one wins: `requested_model` is
 * what the composer selected, while `model_details` describes the model itself.
 *
 * @param {object} runRequest decoded agent.v1.AgentRunRequest
 * @returns {{apiKey: string, baseUrl: string}|null} null when the client sent none
 */
export function requestCredentials(runRequest) {
  const sources = [
    runRequest?.requested_model?.api_key_credentials,
    runRequest?.model_details?.api_key_credentials,
  ];

  for (const source of sources) {
    if (!source) continue;
    const apiKey = typeof source.api_key === "string" ? source.api_key.trim() : "";
    const baseUrl = typeof source.base_url === "string" ? source.base_url.trim() : "";
    if (apiKey.length > 0) return { apiKey, baseUrl };
  }

  return null;
}

/**
 * A key stored in one line, for when the client sends none.
 *
 * Cursor keeps its own copy encrypted, so this is the smallest thing that can stand
 * in for it. One line, no JSON, no nesting.
 *
 * @returns {string} the key, or "" when there is no file
 */
export function storedKey() {
  try {
    const text = fs.readFileSync(apiKeyFile(), "utf8").trim();
    return text.length > 0 ? text : "";
  } catch {
    return "";
  }
}

/**
 * A provider entry, in the same shape `providers.json` produces.
 *
 * @param {{apiKey: string, baseUrl: string}} credentials
 * @param {string} modelId the id the client asked for
 * @param {object} [details] model_details, for the display name and context limit
 * @returns {object}
 */
export function providerFromCredentials(credentials, modelId, details = {}) {
  const baseUrl = credentials.baseUrl.length > 0 ? credentials.baseUrl : "https://api.openai.com/v1";

  return {
    id: "cursor",
    name: "Cursor (model settings)",
    type: inferType(baseUrl),
    baseUrl: baseUrl.replace(/\/+$/, ""),
    auth: { kind: "apiKey", value: credentials.apiKey },
    models: [
      {
        id: modelId,
        apiModel: details.model_id && details.model_id.length > 0 ? details.model_id : modelId,
        displayName:
          details.display_name && details.display_name.length > 0 ? details.display_name : modelId,
        contextTokenLimit: 200_000,
        supportsImages: true,
      },
    ],
  };
}
