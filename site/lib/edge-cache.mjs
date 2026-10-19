/**
 * Worker-level edge cache for public, non-personalised HTML/XML documents.
 *
 * Why: SSR of /, /jobs and /jobs/[slug] costs tens of ms of CPU per request
 * (board parse + React render), above the Workers Free 10 ms CPU limit. The
 * `export async function headers()` in app pages is not honoured by vinext, so
 * those pages went out as `no-store` and every crawler hit re-rendered.
 *
 * Scope is deliberately narrow:
 * - GET only, no query string, no Authorization, no RSC/router request headers
 *   (client navigations and prefetches always render fresh).
 * - Allowlisted public paths only. Attention, checkout, API, and internal routes
 *   never touch this cache.
 * - Only 200 responses (and 404 for /jobs/<slug>) without Set-Cookie are stored.
 * - The key includes the forwarded host (jobappagent.com vs stats.jobappagent.com)
 *   and the deployed release, so a deploy never serves the previous build's HTML.
 *
 * Responses keep their original Cache-Control towards clients/Vercel; only the
 * stored copy carries a TTL for the Cloudflare Cache API.
 */

export const EDGE_CACHE_TTL_SECONDS = 300;
export const EDGE_CACHE_STATUS_HEADER = "x-jaa-edge-cache";
const ORIGINAL_CACHE_CONTROL_HEADER = "x-jaa-edge-orig-cache-control";
const ORIGINAL_VARY_HEADER = "x-jaa-edge-orig-vary";

const EXACT_PATHS = new Set([
  "/",
  "/jobs",
  "/platforms",
  "/privacy",
  "/terms",
  "/community-view",
  "/sitemap.xml",
  "/stats-sitemap.xml",
  "/robots.txt",
  "/manifest.webmanifest",
]);

const ROUTER_REQUEST_HEADERS = [
  "rsc",
  "next-router-state-tree",
  "next-router-prefetch",
  "next-router-segment-prefetch",
  "next-url",
  "x-vinext-interception-context",
  "x-vinext-mounted-slots",
  "x-vinext-rsc-render-mode",
  "x-vinext-rsc-state-fingerprint",
];

const JOB_DETAIL = /^\/jobs\/[^/]+$/;
const PLATFORM_DETAIL = /^\/platforms\/[^/]+$/;

export function isEdgeCacheablePath(pathname) {
  return EXACT_PATHS.has(pathname) || JOB_DETAIL.test(pathname) || PLATFORM_DETAIL.test(pathname);
}

/** @param {Request} request */
export function isEdgeCacheableRequest(request) {
  if (request.method !== "GET") return false;
  let url;
  try { url = new URL(request.url); } catch { return false; }
  if (url.search) return false;
  if (!isEdgeCacheablePath(url.pathname)) return false;
  if (request.headers.has("authorization")) return false;
  for (const name of ROUTER_REQUEST_HEADERS) if (request.headers.has(name)) return false;
  return true;
}

function requestHost(request, url) {
  const raw = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return raw.split(",")[0].trim().split(":")[0].toLowerCase().replace(/[^a-z0-9.-]/g, "") || "unknown";
}

/**
 * @param {Request} request
 * @param {string | undefined} release
 */
export function edgeCacheKey(request, release) {
  const url = new URL(request.url);
  const key = new URL(`/__jaa-edge-cache${url.pathname === "/" ? "/index" : url.pathname}`, url.origin);
  key.searchParams.set("host", requestHost(request, url));
  key.searchParams.set("release", String(release || "dev").slice(0, 64));
  return new Request(key.toString(), { method: "GET" });
}

/** @param {Request} request @param {Response} response */
export function isEdgeStorableResponse(request, response) {
  if (response.headers.has("set-cookie")) return false;
  const pathname = new URL(request.url).pathname;
  if (response.status === 200) return true;
  return response.status === 404 && JOB_DETAIL.test(pathname);
}

/** Copy that the Cache API stores (TTL on the stored copy only). @param {Response} response */
export function toStoredResponse(response) {
  const headers = new Headers(response.headers);
  const original = headers.get("cache-control");
  if (original != null) headers.set(ORIGINAL_CACHE_CONTROL_HEADER, original);
  headers.set("cache-control", `public, max-age=${EDGE_CACHE_TTL_SECONDS}`);
  // The key already excludes RSC/router requests; keep Vary out of the stored copy so
  // the Cache API does not refuse or fragment it, and restore it on a hit.
  const vary = headers.get("vary");
  if (vary != null) headers.set(ORIGINAL_VARY_HEADER, vary);
  headers.delete("vary");
  headers.delete(EDGE_CACHE_STATUS_HEADER);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Restore the client-facing headers on a cache hit. @param {Response} cached */
export function fromStoredResponse(cached) {
  const headers = new Headers(cached.headers);
  const original = headers.get(ORIGINAL_CACHE_CONTROL_HEADER);
  headers.delete(ORIGINAL_CACHE_CONTROL_HEADER);
  if (original != null) headers.set("cache-control", original);
  else headers.delete("cache-control");
  const vary = headers.get(ORIGINAL_VARY_HEADER);
  headers.delete(ORIGINAL_VARY_HEADER);
  if (vary != null) headers.set("vary", vary);
  headers.delete("cf-cache-status");
  headers.delete("age");
  headers.delete("expires");
  headers.set(EDGE_CACHE_STATUS_HEADER, "HIT");
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

/** @param {Response} response @param {string} state */
export function withEdgeCacheStatus(response, state) {
  const headers = new Headers(response.headers);
  headers.set(EDGE_CACHE_STATUS_HEADER, state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Serve from cache or render, store and return.
 * @param {Request} request
 * @param {{ cache: Cache | undefined, release?: string, waitUntil: (p: Promise<unknown>) => void, render: () => Promise<Response> }} options
 */
export async function serveWithEdgeCache(request, { cache, release, waitUntil, render }) {
  if (!cache || !isEdgeCacheableRequest(request)) return render();
  const key = edgeCacheKey(request, release);
  try {
    const cached = await cache.match(key);
    if (cached) return fromStoredResponse(cached);
  } catch {
    /* cache lookup failure must never break the page */
  }
  const response = await render();
  if (!isEdgeStorableResponse(request, response)) return withEdgeCacheStatus(response, "BYPASS");
  const stored = toStoredResponse(response.clone());
  waitUntil(cache.put(key, stored).catch(() => {}));
  return withEdgeCacheStatus(response, "MISS");
}
