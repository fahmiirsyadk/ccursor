/**
 * Everything else Cursor asks for.
 *
 * The router sends a fixed set of RPCs here. Some are ours to answer properly — the
 * clock, the default model, the plan — and the rest are Cursor's own bookkeeping:
 * usage counters, analytics, feature flags, knowledge base, background composers.
 *
 * Those are answered locally with a well-formed empty response rather than an error.
 * An empty message is something the client already knows how to render; an error is
 * a red toast and a broken panel. Answering locally is also what keeps this working
 * when the account has no plan, because nothing is asking Cursor's servers at all.
 */

import { DEFAULT_PORT, providersFile, readJson } from "../paths.js";

/** Model id of the first configured model, for GetDefaultModel. */
function primaryModel() {
  const providers = readJson(providersFile())?.providers ?? [];
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      if (model.id && model.id !== "default") return model.id;
    }
  }
  return "";
}

/** Seconds since the epoch, as the double Cursor expects. */
const now = () => Date.now() / 1000;

/**
 * Handlers that need a real value.
 *
 * Keyed by `service/method`. Each receives the decoded request and returns the
 * response as a plain object.
 */
export const HANDLERS = {
  "aiserver.v1.AiService/ServerTime": () => ({
    receive_timestamp: now(),
    transmit_timestamp: now(),
  }),

  "aiserver.v1.AiService/GetDefaultModel": () => ({
    model: primaryModel(),
    thinking_model: "",
    max_mode: false,
    next_default_set_date: "",
  }),

  "aiserver.v1.AiService/GetDefaultModelNudgeData": () => ({}),

  // The router answers BYOK locally, so there is nothing to pay for and nothing to
  // upgrade. Reporting a paid plan keeps the composer out of upsell states.
  "aiserver.v1.DashboardService/GetPlanInfo": () => ({
    plan_info: {
      plan_name: "BYOK",
      included_amount_cents: 0,
      price: "",
      billing_cycle_end: 0,
      plan_owner: {},
    },
    next_upgrade: {},
  }),

  "aiserver.v1.DashboardService/GetCurrentPeriodUsage": () => ({
    enabled: false,
    billing_cycle_start: 0,
    billing_cycle_end: 0,
    plan_usage: {},
    display_threshold: 0,
  }),

  "aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants": () => ({}),
  "aiserver.v1.DashboardService/IsOnNewPricing": () => ({ is_on_new_pricing: true }),
  "aiserver.v1.DashboardService/GetTeams": () => ({ teams: [] }),
  "aiserver.v1.DashboardService/GetTeamAdminSettings": () => ({}),
  "aiserver.v1.DashboardService/GetTeamAdminSettingsOrEmptyIfNotInTeam": () => ({}),
  "aiserver.v1.DashboardService/GetTeamRepos": () => ({ repos: [] }),
  "aiserver.v1.DashboardService/GetTeamReposOrEmptyIfNotInTeam": () => ({ repos: [] }),
  "aiserver.v1.DashboardService/GetTeamBackgroundAgentSettings": () => ({}),
  "aiserver.v1.DashboardService/GetGlobalCommands": () => ({ commands: [] }),
  "aiserver.v1.DashboardService/GetTeamCommands": () => ({ commands: [] }),
  "aiserver.v1.DashboardService/GetEffectiveUserPlugins": () => ({ plugins: [] }),
  "aiserver.v1.DashboardService/GetManagedSkills": () => ({ skills: [] }),
  "aiserver.v1.DashboardService/GetSlackInstallUrl": () => ({ url: "" }),

  // No storage, no training: the only privacy mode that matches a local endpoint.
  "aiserver.v1.DashboardService/GetUserPrivacyMode": () => ({
    privacy_mode: 1,
    hours_remaining_in_grace_period: 0,
    is_enforced_by_team: false,
    is_not_migrated_to_server_source_of_truth: false,
    partner_data_share: false,
    has_acknowledged_grace_period_disclaimer: true,
  }),

  // Analytics is the one thing this tool exists to stop sending. Accept and drop.
  "aiserver.v1.AnalyticsService/Batch": () => ({}),

  "aiserver.v1.AiService/KnowledgeBaseList": () => ({ items: [], total_count: 0, total_pages: 0 }),
  "aiserver.v1.AiService/KnowledgeBaseAdd": () => ({ item: {} }),
  "aiserver.v1.AiService/KnowledgeBaseUpdate": () => ({ item: {} }),
  "aiserver.v1.AiService/KnowledgeBaseRemove": () => ({}),

  "aiserver.v1.ChatService/GetConversationSummary": () => ({ summary: "" }),
  "aiserver.v1.ChatService/StreamSpeculativeSummaries": () => ({ summary: "" }),

  "aiserver.v1.BackgroundComposerService/ListBackgroundComposers": () => ({ composers: [] }),
  "aiserver.v1.BackgroundComposerService/GetBackgroundComposerUserSettings": () => ({}),
  "aiserver.v1.BackgroundComposerService/ListTeamEnvironments": () => ({ environments: [] }),
  "aiserver.v1.BackgroundComposerService/ListPersonalEnvironments": () => ({ environments: [] }),

  "aiserver.v1.InAppAdService/GetAllAdPreviews": () => ({ previews: [] }),
};

/** Auth endpoints the renderer hits directly, not as RPCs. */
export const REST = {
  "/auth/full_stripe_profile": () => ({ membershipType: "pro", isYearlyPlan: false }),
  "/auth/stripe_profile": () => ({ membershipType: "pro", isYearlyPlan: false }),
  "/auth/has_valid_payment_method": () => ({ hasValidPaymentMethod: true }),
  "/auth/logout": () => ({ ok: true }),
  "/auth/poll": () => ({ accessToken: "byok-local", authId: "byok-local" }),
};

/** A response body for a route we have no handler for: a valid empty message. */
export function emptyResponse() {
  return {};
}

export { DEFAULT_PORT };
