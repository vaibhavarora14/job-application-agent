import { env } from "cloudflare:workers";
import { validateCommunityStats } from "../../../lib/community-stats.mjs";
import { workersDefaultCache } from "../../../lib/workers-cache";

const CACHE_CONTROL = "public, max-age=60, s-maxage=900, stale-while-revalidate=3600";
const MAX_UPSTREAM_BYTES = 128 * 1024;

export async function GET(request: Request) {
  const cache = workersDefaultCache();
  const cacheKey = new Request(request.url, { method: "GET" });
  if (cache) {
    const cached = await cache.match(cacheKey);
    // Cache API responses have immutable headers; vinext adjusts headers on the way
    // out, so hand back a mutable copy (returning `cached` directly throws -> 1101).
    if (cached) return new Response(cached.body, cached);
  }

  const upstream = env.COMMUNITY_STATS_UPSTREAM;
  if (!upstream) return Response.json({ error: "stats_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  try {
    const fetcher = (env as unknown as { TELEMETRY?: { fetch: typeof fetch } }).TELEMETRY?.fetch?.bind(
      (env as unknown as { TELEMETRY?: { fetch: typeof fetch } }).TELEMETRY,
    ) ?? fetch;
    const response = await fetcher(new Request(upstream, { headers: { accept: "application/json" } }));
    if (!response.ok) throw new Error("upstream unavailable");
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_UPSTREAM_BYTES) throw new Error("upstream response too large");
    const result = validateCommunityStats(JSON.parse(raw));
    if (!result.ok) throw new Error("invalid upstream response");
    const next = Response.json(result.data, { headers: { "cache-control": CACHE_CONTROL, "x-content-type-options": "nosniff" } });
    if (cache) await cache.put(cacheKey, next.clone());
    return next;
  } catch {
    return Response.json({ error: "stats_unavailable" }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } });
  }
}
