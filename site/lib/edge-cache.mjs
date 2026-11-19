/**
 * Worker-level edge cache for public, non-personalised HTML/XML/JSON documents.
 *
 * Why: SSR of /, /jobs and /jobs/[slug] costs tens of ms of CPU per request
 * (board parse + React render), above the Workers Free 10 ms CPU limit. Crawlers
 * hit many distinct slugs; without an edge hit they each re-render and trip
 * `exceededResources`. The `export async function headers()` in app pages is not
 * honoured by vinext, so those pages used to go out as `no-store`.
 *
 * Strategy: Workers Cache API (`caches.default`) with stale-while-revalidate.
 * Fresh hits return immediately. After the fresh TTL the stored copy is still
 * served (STALE) while `ctx.waitUntil` refreshes it. Concurrent misses in one
 * isolate coalesce through a plain-value snapshot (and Cache API) so a burst
 * still renders once when the leader finishes — followers never await another
 * request's promise, which the runtime refuses to settle after that request ends.
 *
 * Scope:
 * - GET/HEAD only. No Authorization. No session/auth cookies (`founding_purchase`
 *   is the only app cookie today). No RSC/router request headers.
 * - Allowlisted public paths only. Attention, checkout, webhook, and other API
 *   routes never touch this cache.
 * - Document pages: tracking query params (`utm_*`, `gclid`, …) are stripped from
 *   the key; any remaining query bypasses the cache. Public aggregate JSON proxies
 *   keep their validated query in the key. `/api/community-jobs-live` is never
 *   edge-cached (always BYPASS) so liveness stays fresh.
 * - Only 200 responses (and 404 for /jobs/<slug>, short TTL) without Set-Cookie.
 * - Key includes forwarded host, document/RSC variant and deployed release so a
 *   deploy never serves the previous build's HTML and stats.jobappagent.com `/` can
 *   never share an entry with the apex `/`.
 *
 * Shared proxy cache (Vercel): the jobappagent.com domains reach this Worker
 * through a Vercel external rewrite (`site-proxy/vercel.json`) that sends every host
 * to the same workers.dev URL. Vercel keys cached external-rewrite responses on the
 * destination URL, not the public host, and projects created after 2026-04-06 honour
 * upstream `s-maxage` by default. Our `s-maxage` therefore let one host's `/` (stats
 * vs apex) be served for the other per Vercel region. Every Worker response carries
 * `Vercel-CDN-Cache-Control: private, no-store` (highest-priority Vercel directive) so
 * Vercel never stores it; this Worker cache (host-keyed) does the caching instead.
 */

import { boardQueryString, parseBoardQuery } from "./jobs-board-query.mjs";

/** Document / page fresh + SWR window (~1h). */
export const EDGE_CACHE_TTL_SECONDS = 3600;
export const EDGE_CACHE_SWR_SECONDS = 3600;
/** Aggregate JSON APIs (stats + jobs list) — shorter so board data stays fresher. */
export const EDGE_CACHE_API_TTL_SECONDS = 300;
export const EDGE_CACHE_API_SWR_SECONDS = 300;
export const EDGE_CACHE_404_TTL_SECONDS = 60;
/**
 * Pages whose server render depends only on the deployed build and the host: no
 * board data, clock, cookies or env reads on the server (live numbers on them load
 * client-side). The key already carries the release, so a deploy replaces them; until
 * then a re-render returns the same HTML, and a 1 h SWR refresh only spent a full
 * cold-isolate SSR (100+ ms CPU on Workers Free) to store identical bytes.
 * Fresh for a day, then served stale for up to 6 more while one refresh runs.
 */
export const EDGE_CACHE_STATIC_TTL_SECONDS = 24 * 3600;
export const EDGE_CACHE_STATIC_SWR_SECONDS = 6 * 24 * 3600;
const RELEASE_STATIC_PATHS = new Set([
  "/",
  "/platforms",
  "/privacy",
  "/terms",
  "/community-view",
  "/open-source",
  "/compare",
  "/robots.txt",
  "/manifest.webmanifest",
]);

/** @param {string} pathname */
export function isReleaseStaticPath(pathname) {
  return RELEASE_STATIC_PATHS.has(pathname) || PLATFORM_DETAIL.test(pathname);
}
/** Debug header: HIT | MISS | STALE | BYPASS */
export const EDGE_CACHE_STATUS_HEADER = "x-cache";
/** Vercel-only CDN directive; outranks CDN-Cache-Control and Cache-Control on Vercel. */
export const SHARED_PROXY_CACHE_CONTROL_HEADER = "vercel-cdn-cache-control";
export const SHARED_PROXY_CACHE_CONTROL = "private, no-store";
const ORIGINAL_CACHE_CONTROL_HEADER = "x-jaa-edge-orig-cache-control";
const ORIGINAL_VARY_HEADER = "x-jaa-edge-orig-vary";
const FRESH_UNTIL_HEADER = "x-jaa-edge-fresh-until";

/** Only cookie the site Worker sets today (checkout). Bypass whenever present. */
export const EDGE_CACHE_AUTH_COOKIES = Object.freeze(["founding_purchase"]);

const EXACT_PATHS = new Set([
  "/",
  "/jobs",
  "/platforms",
  "/privacy",
  "/terms",
  "/community-view",
  "/open-source",
  "/compare",
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

/**
 * Public aggregate JSON proxied from the telemetry relay. Their in-route Cache API
 * lookups never hit inside vinext, so each call re-ran ~20-35 ms of fetch + validation.
 * Query (limit/cursor) is part of the key.
 * `/api/community-jobs-live` is intentionally excluded — always BYPASS.
 */
const PUBLIC_API_PATHS = new Set([
  "/api/community-stats",
  "/api/community-jobs",
  // Filter-sheet match count; computed in-app from the memoised board.
  "/api/jobs/count",
]);

/**
 * Paths whose query is the /jobs filter state. Only the canonical form of a valid
 * filter query is cached (one entry per filter combination); anything else bypasses.
 */
const BOARD_QUERY_PATHS = new Set(["/jobs", "/api/jobs/count"]);

function sortedParams(params) {
  const copy = new URLSearchParams(params);
  copy.sort();
  return copy;
}

/** Paths that must never touch caches.default (always x-cache: BYPASS). */
const EDGE_CACHE_NEVER_PATHS = new Set([
  "/api/community-jobs-live",
]);

const JOB_DETAIL = /^\/jobs\/[^/]+$/;
const PLATFORM_DETAIL = /^\/platforms\/[^/]+$/;

/** Tracking params that do not change SSR output on allowlisted document pages. */
const TRACKING_QUERY_PARAM = /^(utm_[a-z0-9_]+|gclid|dclid|fbclid|msclkid|gbraid|wbraid|mc_[a-z0-9_]+|ref|ref_src)$/i;

/** @type {Map<string, number>} leader start times — not promises; sharing those across requests throws */
const inflightStartedAt = new Map();
/** @type {Map<string, { until: number, value: unknown }>} plain snapshots so a follower can reuse a finished miss without awaiting I/O */
const inflightResults = new Map();
/** How long a follower waits for a leader snapshot before rendering itself. */
export const EDGE_CACHE_COALESCE_WAIT_MS = 2_000;
const COALESCE_POLL_MS = 20;
/** How long a finished miss snapshot is kept for concurrent followers. */
export const EDGE_CACHE_COALESCE_RESULT_MS = 2_000;
/** Cap on in-isolate miss snapshots (each holds a response body). */
export const EDGE_CACHE_COALESCE_SNAPSHOT_MAX = 64;
/**
 * Background SWR claim lifetime if `finally` never runs (CPU kill). Matches the
 * Workers `waitUntil` ceiling so a slow refresh is not treated as expired at the
 * 2s follower window.
 */
export const EDGE_CACHE_REVALIDATE_CLAIM_MS = 30_000;

export function isEdgeCacheablePath(pathname) {
  return (
    EXACT_PATHS.has(pathname)
    || JOB_DETAIL.test(pathname)
    || PLATFORM_DETAIL.test(pathname)
    || PUBLIC_API_PATHS.has(pathname)
  );
}

export function edgeCacheTtlSeconds(pathname, status = 200) {
  if (status === 404 && JOB_DETAIL.test(pathname)) return EDGE_CACHE_404_TTL_SECONDS;
  if (PUBLIC_API_PATHS.has(pathname)) return EDGE_CACHE_API_TTL_SECONDS;
  if (status === 200 && isReleaseStaticPath(pathname)) return EDGE_CACHE_STATIC_TTL_SECONDS;
  return EDGE_CACHE_TTL_SECONDS;
}

export function edgeCacheSwrSeconds(pathname, status = 200) {
  if (status === 404) return 0;
  if (PUBLIC_API_PATHS.has(pathname)) return EDGE_CACHE_API_SWR_SECONDS;
  if (status === 200 && isReleaseStaticPath(pathname)) return EDGE_CACHE_STATIC_SWR_SECONDS;
  return EDGE_CACHE_SWR_SECONDS;
}

/**
 * Strip tracking params for document pages. Returns null when a remaining query
 * means the request must bypass the cache (unknown content effect).
 * @param {string} pathname
 * @param {URLSearchParams} searchParams
 * @returns {URLSearchParams | null}
 */
export function normalizeEdgeCacheSearch(pathname, searchParams) {
  if (BOARD_QUERY_PATHS.has(pathname)) {
    const kept = new URLSearchParams();
    for (const [key, value] of searchParams.entries()) {
      if (!TRACKING_QUERY_PARAM.test(key)) kept.append(key, value);
    }
    const raw = sortedParams(kept);
    const canonical = sortedParams(boardQueryString(parseBoardQuery(kept), { keepShow: true, keepDesign: true }));
    return raw.toString() === canonical.toString() ? canonical : null;
  }
  if (PUBLIC_API_PATHS.has(pathname)) {
    const kept = new URLSearchParams();
    const entries = [...searchParams.entries()].sort(([a], [b]) => a.localeCompare(b) || 0);
    for (const [key, value] of entries) kept.append(key, value);
    return kept;
  }
  const kept = new URLSearchParams();
  for (const [key, value] of searchParams.entries()) {
    if (TRACKING_QUERY_PARAM.test(key)) continue;
    kept.append(key, value);
  }
  if ([...kept.keys()].length > 0) return null;
  return kept;
}

/** @param {string | null} cookieHeader */
export function hasEdgeCacheAuthCookie(cookieHeader) {
  if (!cookieHeader) return false;
  for (const part of cookieHeader.split(";")) {
    const name = part.trim().split("=")[0];
    if (name && EDGE_CACHE_AUTH_COOKIES.includes(name)) return true;
  }
  return false;
}

/**
 * @param {Request} request
 * @returns {null | "method" | "path" | "never" | "query" | "authorization" | "cookie" | "router"}
 */
export function edgeCacheBypassReason(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return "method";
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return "path";
  }
  if (EDGE_CACHE_NEVER_PATHS.has(url.pathname)) return "never";
  if (!isEdgeCacheablePath(url.pathname)) return "path";
  if (url.search.length > 512) return "query";
  if (normalizeEdgeCacheSearch(url.pathname, url.searchParams) === null) return "query";
  if (request.headers.has("authorization")) return "authorization";
  if (hasEdgeCacheAuthCookie(request.headers.get("cookie"))) return "cookie";
  for (const name of ROUTER_REQUEST_HEADERS) {
    if (request.headers.has(name)) return "router";
  }
  return null;
}

/** @param {Request} request */
export function isEdgeCacheableRequest(request) {
  return edgeCacheBypassReason(request) === null;
}

function requestHost(request, url) {
  const raw = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  return raw.split(",")[0].trim().split(":")[0].toLowerCase().replace(/[^a-z0-9.-]/g, "") || "unknown";
}

/**
 * Stable GET cache key (HEAD shares the GET entry).
 * @param {Request} request
 * @param {string | undefined} release
 */
export function edgeCacheKey(request, release) {
  const url = new URL(request.url);
  const key = new URL(`/__jaa-edge-cache${url.pathname === "/" ? "/index" : url.pathname}`, url.origin);
  key.searchParams.set("host", requestHost(request, url));
  // Router/RSC requests bypass this cache today; keep the variant in the key anyway so
  // an RSC payload can never be stored under (or served for) the HTML document key.
  key.searchParams.set("variant", request.headers.has("rsc") ? "rsc" : "document");
  key.searchParams.set("release", String(release || "dev").slice(0, 64));
  const normalized = normalizeEdgeCacheSearch(url.pathname, url.searchParams);
  if (normalized && [...normalized.keys()].length > 0) {
    key.searchParams.set("q", normalized.toString());
  }
  return new Request(key.toString(), { method: "GET" });
}

/** @param {Request} request @param {Response} response */
export function isEdgeStorableResponse(request, response) {
  if (response.headers.has("set-cookie")) return false;
  const pathname = new URL(request.url).pathname;
  if (PUBLIC_API_PATHS.has(pathname)) {
    return response.status === 200 && (response.headers.get("content-type") ?? "").includes("application/json");
  }
  if (response.status === 200) return true;
  return response.status === 404 && JOB_DETAIL.test(pathname);
}

function clientCacheControl(ttlSeconds, swrSeconds) {
  if (swrSeconds > 0) {
    return `public, max-age=0, s-maxage=${ttlSeconds}, stale-while-revalidate=${swrSeconds}`;
  }
  return `public, max-age=0, s-maxage=${ttlSeconds}`;
}

/**
 * Copy that the Cache API stores (TTL = fresh + SWR so stale entries remain matchable).
 * @param {Response} response
 * @param {{ ttlSeconds?: number, swrSeconds?: number, now?: number }} [options]
 */
export function toStoredResponse(response, options = {}) {
  const ttlSeconds = options.ttlSeconds ?? EDGE_CACHE_TTL_SECONDS;
  const swrSeconds = options.swrSeconds ?? EDGE_CACHE_SWR_SECONDS;
  const now = options.now ?? Date.now();
  const headers = new Headers(response.headers);
  const original = headers.get("cache-control");
  if (original != null) headers.set(ORIGINAL_CACHE_CONTROL_HEADER, original);
  headers.set("cache-control", `public, max-age=${ttlSeconds + swrSeconds}`);
  headers.set(FRESH_UNTIL_HEADER, String(now + ttlSeconds * 1000));
  const vary = headers.get("vary");
  if (vary != null) headers.set(ORIGINAL_VARY_HEADER, vary);
  headers.delete("vary");
  headers.delete(EDGE_CACHE_STATUS_HEADER);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * Restore client-facing headers on a cache hit/stale serve.
 * @param {Response} cached
 * @param {"HIT" | "STALE"} state
 * @param {{ ttlSeconds?: number, swrSeconds?: number }} [options]
 */
export function fromStoredResponse(cached, state = "HIT", options = {}) {
  const ttlSeconds = options.ttlSeconds ?? EDGE_CACHE_TTL_SECONDS;
  const swrSeconds = options.swrSeconds ?? EDGE_CACHE_SWR_SECONDS;
  const headers = new Headers(cached.headers);
  headers.delete(ORIGINAL_CACHE_CONTROL_HEADER);
  headers.delete(FRESH_UNTIL_HEADER);
  headers.set("cache-control", clientCacheControl(ttlSeconds, swrSeconds));
  const vary = headers.get(ORIGINAL_VARY_HEADER);
  headers.delete(ORIGINAL_VARY_HEADER);
  if (vary != null) headers.set("vary", vary);
  headers.delete("cf-cache-status");
  headers.delete("age");
  headers.delete("expires");
  headers.set(EDGE_CACHE_STATUS_HEADER, state);
  return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
}

/**
 * Forbid the Vercel proxy from storing a Worker response. Its external-rewrite cache
 * key ignores the public host, so a stored `/` from stats.jobappagent.com would be
 * served for jobappagent.com (and vice versa). Applied to every Worker response.
 * @param {Response} response
 */
export function withSharedProxyNoStore(response) {
  const headers = new Headers(response.headers);
  headers.set(SHARED_PROXY_CACHE_CONTROL_HEADER, SHARED_PROXY_CACHE_CONTROL);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** @param {Response} response @param {string} state */
export function withEdgeCacheStatus(response, state) {
  const headers = new Headers(response.headers);
  headers.set(EDGE_CACHE_STATUS_HEADER, state);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** @param {Response} response */
function asHeadResponse(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * @param {(request?: Request) => Promise<Response>} render
 * @param {Request} request
 */
function callRender(render, request) {
  if (request.method === "HEAD") {
    const getRequest = new Request(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: request.redirect,
    });
    return render(getRequest);
  }
  return render(request);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCrossRequestIoError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('created by a request that has since ended')
    || message.includes('Cannot perform I/O on behalf of a different request')
    || message.includes('handle_cross_request_promise_resolution')
  );
}

/**
 * Coalesce concurrent work for one cache key inside this isolate without sharing
 * promises across requests. Followers poll a plain snapshot (or give up and run
 * `task` themselves) so a cancelled leader cannot 500 them.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function coalesceEdgeCacheWork(key, task) {
  const now = Date.now();
  pruneInflightResults(now);
  const cached = inflightResults.get(key);
  if (cached && now < cached.until) return Promise.resolve(/** @type {T} */ (cached.value));

  const started = inflightStartedAt.get(key);
  if (started && now - started < EDGE_CACHE_COALESCE_WAIT_MS) {
    return waitForCoalescedResult(key).then((value) => (
      value !== undefined ? /** @type {T} */ (value) : runCoalescedWork(key, task)
    ));
  }
  return runCoalescedWork(key, task);
}

/**
 * @param {string} key
 * @returns {Promise<unknown>}
 */
async function waitForCoalescedResult(key) {
  const deadline = Date.now() + EDGE_CACHE_COALESCE_WAIT_MS;
  while (Date.now() < deadline) {
    pruneInflightResults();
    const cached = inflightResults.get(key);
    if (cached && Date.now() < cached.until) return cached.value;
    if (!inflightStartedAt.has(key)) return undefined;
    await sleep(COALESCE_POLL_MS);
  }
  return undefined;
}

/**
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function runCoalescedWork(key, task) {
  const started = Date.now();
  inflightStartedAt.set(key, started);
  try {
    const value = await task();
    storeInflightResult(key, value);
    return value;
  } finally {
    if (inflightStartedAt.get(key) === started) inflightStartedAt.delete(key);
  }
}

/**
 * Claim exclusive background work for `key` without returning a shared promise.
 * @param {string} key
 * @returns {number} start token, or 0 if another request already claimed it
 */
function claimEdgeCacheWork(key) {
  const started = inflightStartedAt.get(key);
  if (started && Date.now() - started < EDGE_CACHE_REVALIDATE_CLAIM_MS) return 0;
  const now = Date.now();
  inflightStartedAt.set(key, now);
  return now;
}

function pruneInflightResults(now = Date.now()) {
  for (const [key, entry] of inflightResults) {
    if (now >= entry.until) inflightResults.delete(key);
  }
}

/** @param {string} key @param {unknown} value */
function storeInflightResult(key, value) {
  const now = Date.now();
  pruneInflightResults(now);
  inflightResults.set(key, { until: now + EDGE_CACHE_COALESCE_RESULT_MS, value });
  while (inflightResults.size > EDGE_CACHE_COALESCE_SNAPSHOT_MAX) {
    const oldest = inflightResults.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    inflightResults.delete(oldest);
  }
}

/** Test helper: clear in-flight coalesce maps. */
export function resetEdgeCacheInflight() {
  inflightStartedAt.clear();
  inflightResults.clear();
}

/** Test helper: in-isolate miss snapshot count after pruning expired entries. */
export function edgeCacheInflightSnapshotSize() {
  pruneInflightResults();
  return inflightResults.size;
}

/**
 * @param {Request} request
 * @param {Response} response
 * @param {number} now
 */
function storeOptionsFor(request, response, now) {
  const pathname = new URL(request.url).pathname;
  const ttlSeconds = edgeCacheTtlSeconds(pathname, response.status);
  const swrSeconds = edgeCacheSwrSeconds(pathname, response.status);
  return { ttlSeconds, swrSeconds, now };
}

/**
 * Fresh-hit fast path, run before the Sentry wrapper and the app router are entered.
 *
 * Why: on Workers Free most requests land on a cold or rarely used isolate, and even a
 * cache HIT through the full stack paid for Sentry's per-request SDK setup plus the app
 * wrapper (~8-13 ms CPU on a cold isolate in local measurements, vs ~1 ms warm). A fresh
 * stored copy needs none of that: the stored response already carries the security
 * headers it was rendered with. Returns the exact response `serveWithEdgeCache` would
 * return for a HIT, or null (stale, miss, bypass, or any error) so the caller runs the
 * normal path, which re-checks the cache itself.
 * @param {Request} request
 * @param {{ cache: Cache | undefined, release?: string, now?: () => number }} options
 * @returns {Promise<Response | null>}
 */
export async function serveFreshEdgeCacheHit(request, { cache, release, now = Date.now }) {
  if (!cache) return null;
  try {
    if (edgeCacheBypassReason(request) !== null) return null;
    const cached = await cache.match(edgeCacheKey(request, release));
    if (!cached) return null;
    if (!(now() < Number(cached.headers.get(FRESH_UNTIL_HEADER) || 0))) return null;
    const pathname = new URL(request.url).pathname;
    const hit = fromStoredResponse(cached, "HIT", {
      ttlSeconds: edgeCacheTtlSeconds(pathname, cached.status),
      swrSeconds: edgeCacheSwrSeconds(pathname, cached.status),
    });
    return request.method === "HEAD" ? asHeadResponse(hit) : hit;
  } catch {
    return null;
  }
}

/**
 * Serve from cache or render, store and return.
 * @param {Request} request
 * @param {{
 *   cache: Cache | undefined,
 *   release?: string,
 *   waitUntil: (p: Promise<unknown>) => void,
 *   render: (request?: Request) => Promise<Response>,
 *   now?: () => number,
 * }} options
 */
export async function serveWithEdgeCache(request, { cache, release, waitUntil, render, now = Date.now }) {
  const bypass = edgeCacheBypassReason(request);
  if (bypass === "never" || bypass === "cookie" || bypass === "authorization" || bypass === "query") {
    // Never touch caches.default for these — including community-jobs-live.
    return withEdgeCacheStatus(await callRender(render, request), "BYPASS");
  }
  if (!cache || bypass === "method" || bypass === "path" || bypass === "router") {
    return callRender(render, request);
  }

  const isHead = request.method === "HEAD";
  const key = edgeCacheKey(request, release);
  const coalesceId = key.url;
  const currentNow = () => now();

  try {
    const cached = await cache.match(key);
    if (cached) {
      const pathname = new URL(request.url).pathname;
      const freshUntil = Number(cached.headers.get(FRESH_UNTIL_HEADER) || 0);
      const ttlSeconds = edgeCacheTtlSeconds(pathname, cached.status);
      const swrSeconds = edgeCacheSwrSeconds(pathname, cached.status);
      if (currentNow() < freshUntil) {
        const hit = fromStoredResponse(cached, "HIT", { ttlSeconds, swrSeconds });
        return isHead ? asHeadResponse(hit) : hit;
      }
      // Still inside Cache API max-age (fresh + SWR): serve stale, refresh once.
      const revalidateKey = `revalidate:${coalesceId}`;
      const revalidateStarted = claimEdgeCacheWork(revalidateKey);
      if (revalidateStarted) {
        waitUntil((async () => {
          try {
            const rendered = await callRender(render, request);
            if (!isEdgeStorableResponse(request, rendered)) return;
            const stored = toStoredResponse(rendered, storeOptionsFor(request, rendered, currentNow()));
            await cache.put(key, stored);
          } catch {
            /* background refresh must never throw into the isolate */
          } finally {
            if (inflightStartedAt.get(revalidateKey) === revalidateStarted) {
              inflightStartedAt.delete(revalidateKey);
            }
          }
        })());
      }
      const stale = fromStoredResponse(cached, "STALE", { ttlSeconds, swrSeconds });
      return isHead ? asHeadResponse(stale) : stale;
    }
  } catch {
    /* cache lookup failure must never break the page */
  }

  try {
    const shared = await coalesceEdgeCacheWork(`miss:${coalesceId}`, () => renderMissSnapshot({
      request,
      render,
      cache,
      key,
      waitUntil,
      now: currentNow,
    }));
    return responseFromSnapshot(shared, isHead);
  } catch (error) {
    if (!isCrossRequestIoError(error)) throw error;
    const shared = await renderMissSnapshot({
      request,
      render,
      cache,
      key,
      waitUntil,
      now: currentNow,
    });
    return responseFromSnapshot(shared, isHead);
  }
}

/**
 * @param {{
 *   request: Request,
 *   render: (request?: Request) => Promise<Response>,
 *   cache: Cache,
 *   key: Request,
 *   waitUntil: (p: Promise<unknown>) => void,
 *   now: () => number,
 * }} input
 * @returns {Promise<{ status: number, statusText: string, headers: [string, string][], body: ArrayBuffer, cacheStatus: string }>}
 */
async function renderMissSnapshot({ request, render, cache, key, waitUntil, now }) {
  try {
    const raced = await cache.match(key);
    if (raced) {
      const pathname = new URL(request.url).pathname;
      const ttlSeconds = edgeCacheTtlSeconds(pathname, raced.status);
      const swrSeconds = edgeCacheSwrSeconds(pathname, raced.status);
      const state = now() < Number(raced.headers.get(FRESH_UNTIL_HEADER) || 0) ? "HIT" : "STALE";
      const rebuilt = fromStoredResponse(raced, state, { ttlSeconds, swrSeconds });
      return {
        status: rebuilt.status,
        statusText: rebuilt.statusText,
        headers: [...rebuilt.headers.entries()],
        body: await rebuilt.arrayBuffer(),
        cacheStatus: state,
      };
    }
  } catch {
    /* ignore */
  }

  const rendered = await callRender(render, request);
  if (!isEdgeStorableResponse(request, rendered)) {
    const bypassed = withEdgeCacheStatus(rendered, "BYPASS");
    return {
      status: bypassed.status,
      statusText: bypassed.statusText,
      headers: [...bypassed.headers.entries()],
      body: await bypassed.arrayBuffer(),
      cacheStatus: "BYPASS",
    };
  }

  const opts = storeOptionsFor(request, rendered, now());
  const forClient = withEdgeCacheStatus(rendered, "MISS");
  const clientHeaders = new Headers(forClient.headers);
  clientHeaders.set("cache-control", clientCacheControl(opts.ttlSeconds, opts.swrSeconds));
  const body = await forClient.arrayBuffer();
  const toCache = toStoredResponse(new Response(body.slice(0), {
    status: forClient.status,
    statusText: forClient.statusText,
    headers: clientHeaders,
  }), opts);
  waitUntil(cache.put(key, toCache).catch(() => {}));
  return {
    status: forClient.status,
    statusText: forClient.statusText,
    headers: [...clientHeaders.entries()],
    body,
    cacheStatus: "MISS",
  };
}

/**
 * @param {{ status: number, statusText: string, headers: [string, string][], body: ArrayBuffer, cacheStatus: string }} shared
 * @param {boolean} isHead
 */
function responseFromSnapshot(shared, isHead) {
  const headers = new Headers(shared.headers);
  headers.set(EDGE_CACHE_STATUS_HEADER, shared.cacheStatus);
  if (isHead) {
    return new Response(null, {
      status: shared.status,
      statusText: shared.statusText,
      headers,
    });
  }
  return new Response(shared.body.slice(0), {
    status: shared.status,
    statusText: shared.statusText,
    headers,
  });
}
