/**
 * Sentry helpers for the site Worker.
 *
 * DSN comes only from env.SENTRY_DSN (wrangler secret). Never hardcode a DSN.
 * Privacy: no user PII, cookies, HTTP bodies, or query params in events.
 */
import * as Sentry from "@sentry/cloudflare";
import {
  SITE_SENTRY_SERVICE,
  resolveSentryEnvironment,
  siteSentryOptions,
} from "./sentry-options.mjs";

export { SITE_SENTRY_SERVICE, resolveSentryEnvironment, siteSentryOptions };

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
