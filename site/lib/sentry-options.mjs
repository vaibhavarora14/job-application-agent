/**
 * Pure Sentry option helpers (no SDK import).
 * Used by the Worker wrapper and by root `npm test` without site node_modules.
 *
 * DSN comes only from env.SENTRY_DSN (wrangler secret). Never hardcode a DSN.
 * Release comes from env.SENTRY_RELEASE (set to GITHUB_SHA on deploy).
 */

export const SITE_SENTRY_SERVICE = "site";

/**
 * Must match `name` in site/wrangler.jsonc.
 * Version URLs are `<prefix>-<name>.<account>.workers.dev`.
 */
export const SITE_WORKER_NAME = "job-application-agent-site";

/** @param {string | undefined} value */
function isJobAppAgentProductionHost(value) {
  try {
    const host = new URL(value ?? "").hostname.toLowerCase();
    return host === "jobappagent.com" || host.endsWith(".jobappagent.com");
  } catch {
    return false;
  }
}

/** @param {{ SENTRY_ENVIRONMENT?: string, PUBLIC_SITE_URL?: string }} env */
export function resolveSentryEnvironment(env) {
  if (env.SENTRY_ENVIRONMENT?.trim()) return env.SENTRY_ENVIRONMENT.trim();
  if (isJobAppAgentProductionHost(env.PUBLIC_SITE_URL)) return "production";
  return "development";
}

/**
 * @param {string | undefined} value URL or hostname
 * @returns {string}
 */
function requestHostname(value) {
  if (typeof value !== "string" || value.trim() === "") return "";
  try {
    const url = value.includes("://") ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Cloudflare version and alias URLs:
 * `<version-or-alias>-<worker-name>.<subdomain>.workers.dev`.
 * The production workers.dev host is `<worker-name>.<subdomain>.workers.dev`.
 * @param {string | undefined} hostnameOrUrl
 */
export function isSiteVersionPreviewHost(hostnameOrUrl) {
  const host = requestHostname(hostnameOrUrl);
  if (!host.endsWith(".workers.dev")) return false;
  const label = host.split(".")[0] ?? "";
  const prefixed = `-${SITE_WORKER_NAME}`;
  return label.endsWith(prefixed) && label.length > prefixed.length;
}

/**
 * Version-preview hosts inherit production bindings (`PUBLIC_SITE_URL`), so
 * reporting them files a production error and pages. Drop those events.
 * jobappagent.com, its subdomains, and the main workers.dev host still report.
 * Missing or unparseable URLs report (fail open).
 * @param {string | undefined} requestUrl
 */
export function shouldReportSiteSentryForUrl(requestUrl) {
  if (typeof requestUrl !== "string" || requestUrl.trim() === "") return true;
  return !isSiteVersionPreviewHost(requestUrl);
}

/**
 * Options for `Sentry.withSentry`. Returns undefined when DSN is unset (no-op).
 * @param {{
 *   SENTRY_DSN?: string,
 *   SENTRY_ENVIRONMENT?: string,
 *   SENTRY_RELEASE?: string,
 *   PUBLIC_SITE_URL?: string,
 * }} env
 */
export function siteSentryOptions(env) {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;

  const release = env.SENTRY_RELEASE?.trim();

  return {
    dsn,
    environment: resolveSentryEnvironment(env),
    ...(release ? { release } : {}),
    // Errors only — no performance tracing of request content.
    tracesSampleRate: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      databaseQueryData: false,
      genAI: { inputs: false, outputs: false },
    },
    initialScope: {
      tags: {
        service: SITE_SENTRY_SERVICE,
      },
    },
    beforeSend(event) {
      const candidates = [event?.request?.url, event?.tags?.url];
      if (candidates.some((url) => typeof url === "string" && !shouldReportSiteSentryForUrl(url))) return null;
      return event;
    },
  };
}
