/**
 * Pure Sentry option helpers (no SDK import).
 * Used by the Worker wrapper and by root `npm test` without site node_modules.
 *
 * DSN comes only from env.SENTRY_DSN (wrangler secret). Never hardcode a DSN.
 */

export const SITE_SENTRY_SERVICE = "site";

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
 * Options for `Sentry.withSentry`. Returns undefined when DSN is unset (no-op).
 * @param {{ SENTRY_DSN?: string, SENTRY_ENVIRONMENT?: string, PUBLIC_SITE_URL?: string }} env
 */
export function siteSentryOptions(env) {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return undefined;

  return {
    dsn,
    environment: resolveSentryEnvironment(env),
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
  };
}
