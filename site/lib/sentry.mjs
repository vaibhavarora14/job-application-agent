/**
 * Sentry helpers for the site Worker.
 *
 * DSN comes only from env.SENTRY_DSN (wrangler secret). Never hardcode a DSN.
 * Privacy: no user PII, cookies, HTTP bodies, or query params in events.
 */
import * as Sentry from "@sentry/cloudflare";

export const SITE_SENTRY_SERVICE = "site";

/** @param {{ SENTRY_ENVIRONMENT?: string, PUBLIC_SITE_URL?: string }} env */
export function resolveSentryEnvironment(env) {
  if (env.SENTRY_ENVIRONMENT?.trim()) return env.SENTRY_ENVIRONMENT.trim();
  const site = env.PUBLIC_SITE_URL ?? "";
  if (site.includes("jobappagent.com")) return "production";
  return "development";
}

/**
 * Options callback for `Sentry.withSentry`. Returns undefined when DSN is unset (no-op).
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
    sendDefaultPii: false,
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

/**
 * Report a swallowed route error (e.g. checkout catch → 502).
 * @param {unknown} error
 * @param {{ route: string, status?: number }} context
 */
export function captureRouteError(error, context) {
  Sentry.withScope((scope) => {
    scope.setTag("service", SITE_SENTRY_SERVICE);
    scope.setTag("route", context.route);
    if (context.status != null) scope.setTag("http.status_code", String(context.status));
    Sentry.captureException(error);
  });
}

/**
 * Report API responses that returned 5xx without an unhandled throw.
 * Skips when an event was already captured for this request (e.g. captureRouteError).
 * @param {Request} request
 * @param {Response} response
 */
export function captureApiServerError(request, response) {
  if (response.status < 500) return;
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return;
  if (Sentry.lastEventId()) return;

  Sentry.withScope((scope) => {
    scope.setTag("service", SITE_SENTRY_SERVICE);
    scope.setTag("route", url.pathname);
    scope.setTag("http.status_code", String(response.status));
    scope.setLevel("error");
    Sentry.captureMessage(`API ${response.status} ${request.method} ${url.pathname}`);
  });
}
