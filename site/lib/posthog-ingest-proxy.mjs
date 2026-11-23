/**
 * Same-origin `/ingest` reverse proxy to PostHog US (or EU when POSTHOG_HOST is EU).
 * Used by the site Worker so the browser never talks to us.i.posthog.com.
 */

import { DEFAULT_POSTHOG_HOST, resolvePostHogHost } from "./posthog.mjs";

export const POSTHOG_INGEST_PREFIX = "/ingest";
export const POSTHOG_US_ASSETS_HOST = "https://us-assets.i.posthog.com";
export const POSTHOG_EU_ASSETS_HOST = "https://eu-assets.i.posthog.com";

const STRIP_REQUEST_HEADERS = new Set([
  "authorization",
  "cf-connecting-ip",
  "cf-ipcountry",
  "cf-ray",
  "cf-visitor",
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "referer",
  "referrer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

/**
 * @param {string} pathname
 */
export function isPostHogIngestPath(pathname) {
  return pathname === POSTHOG_INGEST_PREFIX || pathname.startsWith(`${POSTHOG_INGEST_PREFIX}/`);
}

/**
 * @param {string | undefined} ingestHost
 */
export function postHogProxyTargets(ingestHost) {
  const ingest = resolvePostHogHost(ingestHost);
  let hostname = "";
  try {
    hostname = new URL(ingest).hostname;
  } catch {
    hostname = "";
  }
  const assets = hostname === "eu.i.posthog.com" ? POSTHOG_EU_ASSETS_HOST : POSTHOG_US_ASSETS_HOST;
  return { ingest, assets };
}

/**
 * @param {string} requestUrl
 * @param {string | undefined} ingestHost
 */
export function postHogProxyUpstreamUrl(requestUrl, ingestHost) {
  const url = new URL(requestUrl);
  const rest = url.pathname.slice(POSTHOG_INGEST_PREFIX.length) || "/";
  const { ingest, assets } = postHogProxyTargets(ingestHost);
  const asset = rest.startsWith("/static/") || rest.startsWith("/array/");
  return new URL(`${rest}${url.search}`, asset ? assets : ingest);
}

/**
 * @param {string | null} value
 */
export function shouldForwardPostHogAuthorization(value) {
  return /^Bearer ph[csx]_/i.test(value ?? "");
}

/**
 * @param {Request} request
 * @param {{
 *   env?: { POSTHOG_HOST?: string },
 *   ingestHost?: string,
 *   fetchFn?: typeof fetch,
 * }} [options]
 */
export async function proxyPostHogIngest(request, options = {}) {
  const method = request.method.toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { allow: "GET, POST, HEAD, OPTIONS", "cache-control": "no-store" },
    });
  }
  if (method !== "GET" && method !== "POST" && method !== "HEAD") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "GET, POST, HEAD, OPTIONS", "cache-control": "no-store" },
    });
  }

  const ingestHost = options.ingestHost ?? options.env?.POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
  const upstreamUrl = postHogProxyUpstreamUrl(request.url, ingestHost);
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (STRIP_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase().startsWith("cf-")) continue;
    headers.set(name, value);
  }
  const authorization = request.headers.get("authorization");
  if (shouldForwardPostHogAuthorization(authorization) && authorization) {
    headers.set("authorization", authorization);
  }
  const ip = request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "";
  if (ip) headers.set("x-forwarded-for", ip);

  const fetchFn = options.fetchFn ?? fetch;
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const upstream = await fetchFn(upstreamUrl.toString(), {
    method,
    headers,
    body,
    redirect: "follow",
  });

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("set-cookie");
  responseHeaders.set("cache-control", "no-store");
  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
