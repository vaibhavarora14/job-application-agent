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
 * served (STALE) while `ctx.waitUntil` refreshes it. An in-isolate map coalesces
 * concurrent miss/stale refreshes for the same key so a burst triggers at most
 * one render per isolate.
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
 * - Key includes forwarded host and deployed release so a deploy never serves the
 *   previous build's HTML.
 */

/** Document / page fresh + SWR window (~1h). */
export const EDGE_CACHE_TTL_SECONDS = 3600;
export const EDGE_CACHE_SWR_SECONDS = 3600;
/** Aggregate JSON APIs (stats + jobs list) — shorter so board data stays fresher. */
export const EDGE_CACHE_API_TTL_SECONDS = 300;
export const EDGE_CACHE_API_SWR_SECONDS = 300;
export const EDGE_CACHE_404_TTL_SECONDS = 60;
/** Debug header: HIT | MISS | STALE | BYPASS */
export const EDGE_CACHE_STATUS_HEADER = "x-cache";
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
]);

/** Paths that must never touch caches.default (always x-cache: BYPASS). */
const EDGE_CACHE_NEVER_PATHS = new Set([
  "/api/community-jobs-live",
]);

const JOB_DETAIL = /^\/jobs\/[^/]+$/;
const PLATFORM_DETAIL = /^\/platforms\/[^/]+$/;

/** Tracking params that do not change SSR output on allowlisted document pages. */
const TRACKING_QUERY_PARAM = /^(utm_[a-z0-9_]+|gclid|dclid|fbclid|msclkid|gbraid|wbraid|mc_[a-z0-9_]+|ref|ref_src)$/i;

/** @type {Map<string, Promise<unknown>>} */
const inflightByKey = new Map();

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
  return EDGE_CACHE_TTL_SECONDS;
}

export function edgeCacheSwrSeconds(pathname, status = 200) {
  if (status === 404) return 0;
  if (PUBLIC_API_PATHS.has(pathname)) return EDGE_CACHE_API_SWR_SECONDS;
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

/**
 * Coalesce concurrent work for one cache key inside this isolate.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function coalesceEdgeCacheWork(key, task) {
  const existing = inflightByKey.get(key);
  if (existing) return /** @type {Promise<T>} */ (existing);
  const pending = Promise.resolve()
    .then(task)
    .finally(() => {
      if (inflightByKey.get(key) === pending) inflightByKey.delete(key);
    });
  inflightByKey.set(key, pending);
  return /** @type {Promise<T>} */ (pending);
}

/** Test helper: clear in-flight coalesce map. */
export function resetEdgeCacheInflight() {
  inflightByKey.clear();
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
      waitUntil(
        coalesceEdgeCacheWork(`revalidate:${coalesceId}`, async () => {
          try {
            const rendered = await callRender(render, request);
            if (!isEdgeStorableResponse(request, rendered)) return;
            const stored = toStoredResponse(rendered, storeOptionsFor(request, rendered, currentNow()));
            await cache.put(key, stored);
          } catch {
            /* background refresh must never throw into the isolate */
          }
        }).catch(() => {}),
      );
      const stale = fromStoredResponse(cached, "STALE", { ttlSeconds, swrSeconds });
      return isHead ? asHeadResponse(stale) : stale;
    }
  } catch {
    /* cache lookup failure must never break the page */
  }

  /** @type {{ status: number, statusText: string, headers: [string, string][], body: ArrayBuffer, cacheStatus: string }} */
  const shared = await coalesceEdgeCacheWork(`miss:${coalesceId}`, async () => {
    try {
      const raced = await cache.match(key);
      if (raced) {
        const pathname = new URL(request.url).pathname;
        const ttlSeconds = edgeCacheTtlSeconds(pathname, raced.status);
        const swrSeconds = edgeCacheSwrSeconds(pathname, raced.status);
        const state = currentNow() < Number(raced.headers.get(FRESH_UNTIL_HEADER) || 0) ? "HIT" : "STALE";
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

    const opts = storeOptionsFor(request, rendered, currentNow());
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
  });

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
