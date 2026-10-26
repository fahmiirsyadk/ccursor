/**
 * Telemetry sinks.
 *
 * The router diverts Cursor's AI RPCs. Everything else still leaves the machine:
 * error reporting, feature-flag assignment, marketplace queries, and Microsoft's
 * inherited VS Code telemetry.
 *
 * These are not part of the agent loop, so they are listed here by host and answered
 * with an empty reply instead of being forwarded. Nothing in this list affects a
 * conversation; blocking one of them only stops a background report.
 *
 * The list is deliberately conservative: a host is only here when nothing the IDE
 * shows depends on the answer. Marketplace and update hosts are absent on purpose —
 * blocking those breaks extension installs and updates.
 */

/** Hosts that only ever carry reports, never a reply the UI renders. */
export const SINK_HOSTS = [
  // Cursor's error reporting and event pipeline.
  "metrics.cursor.sh",
  "api2.cursor.sh/aiserver.v1.AnalyticsService",
  "api2.cursor.sh/aiserver.v1.ClientLoggerService",
  // Microsoft's telemetry and A/B assignment, inherited from VS Code.
  "mobile.events.data.microsoft.com",
  "default.exp-tas.com",
  "vortex.data.microsoft.com",
  "dc.services.visualstudio.com",
];

/** Path the router sends a blocked host to. */
export const SINK_PATH = "/byok/sink";

/**
 * Should a request to this host be dropped?
 *
 * A rule may be a bare host or a host plus a path prefix, so a single noisy RPC can
 * be silenced without silencing the whole host.
 *
 * @param {string} hostname
 * @param {string} [pathname]
 */
export function shouldSink(hostname, pathname = "/") {
  const host = String(hostname ?? "").toLowerCase();
  const path = String(pathname ?? "/");

  for (const rule of SINK_HOSTS) {
    const slash = rule.indexOf("/");
    if (slash === -1) {
      if (host === rule) return true;
      continue;
    }
    const ruleHost = rule.slice(0, slash);
    const rulePath = rule.slice(slash);
    if (host === ruleHost && path.startsWith(rulePath)) return true;
  }
  return false;
}

/**
 * What a blocked request is answered with.
 *
 * 204 tells the caller there is nothing to read, which is what a report wants. Some
 * clients treat a non-2xx as an error worth retrying, so the reply is a success.
 */
export const SINK_STATUS = 204;
