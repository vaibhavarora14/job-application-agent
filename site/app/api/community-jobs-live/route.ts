import { env } from "cloudflare:workers";
import { communityJobsLiveUpstreamUrl, validateLiveJobs } from "../../../lib/live-jobs.mjs";
import { workersDefaultCache } from "../../../lib/workers-cache";

const CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=900";
const MAX_UPSTREAM_BYTES = 256 * 1024;

export async function GET(request: Request) {
  const cache = workersDefaultCache();
  const cacheKey = new Request(request.url, { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    // Cache API responses have immutable headers; vinext adjusts headers on the way
    // out, so hand back a mutable copy (returning `cached` directly throws -> 1101).
    if (cached) return new Response(cached.body, cached);
  }

  const configured = env.COMMUNITY_JOBS_LIVE_UPSTREAM
    ?? (env.COMMUNITY_JOBS_UPSTREAM ? (() => {
      try {
        const url = new URL(env.COMMUNITY_JOBS_UPSTREAM);
        url.pathname = "/v1/jobs/live";
        url.search = "";
        return url.toString();
      } catch {
        return null;
      }
    })() : null)
    ?? (env.COMMUNITY_STATS_UPSTREAM ? new URL("/v1/jobs/live", env.COMMUNITY_STATS_UPSTREAM).toString() : null);
  if (!configured) return Response.json({ error: "jobs_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });

  let upstream;
  try { upstream = communityJobsLiveUpstreamUrl(configured, new URL(request.url)); }
  catch { return Response.json({ error: "invalid_job_query" }, { status: 400, headers: { "cache-control": "no-store" } }); }

  try {
    const fetcher = (env as unknown as { TELEMETRY?: { fetch: typeof fetch } }).TELEMETRY?.fetch?.bind(
      (env as unknown as { TELEMETRY?: { fetch: typeof fetch } }).TELEMETRY,
    ) ?? fetch;
    const response = await fetcher(new Request(upstream, { headers: { accept: "application/json" } }));
    if (!response.ok) throw new Error("upstream unavailable");
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_UPSTREAM_BYTES) throw new Error("upstream response too large");
    const result = validateLiveJobs(JSON.parse(raw));
    if (!result.ok) throw new Error("invalid upstream response");
    const next = Response.json(result.data, { headers: { "cache-control": CACHE_CONTROL, "x-content-type-options": "nosniff" } });
    if (cache) await cache.put(cacheKey, next.clone());
    return next;
  } catch {
    return Response.json({ error: "jobs_unavailable" }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } });
  }
}
