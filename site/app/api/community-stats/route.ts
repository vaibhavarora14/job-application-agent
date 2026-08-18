import { env } from "cloudflare:workers";
import { validateCommunityStats } from "../../../lib/community-stats.mjs";

const CACHE_CONTROL = "public, max-age=60, s-maxage=900, stale-while-revalidate=3600";
const MAX_UPSTREAM_BYTES = 128 * 1024;

export async function GET() {
  const upstream = env.COMMUNITY_STATS_UPSTREAM;
  if (!upstream) return Response.json({ error: "stats_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });
  try {
    const response = await fetch(upstream, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error("upstream unavailable");
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_UPSTREAM_BYTES) throw new Error("upstream response too large");
    const result = validateCommunityStats(JSON.parse(raw));
    if (!result.ok) throw new Error("invalid upstream response");
    return Response.json(result.data, { headers: { "cache-control": CACHE_CONTROL, "x-content-type-options": "nosniff" } });
  } catch {
    return Response.json({ error: "stats_unavailable" }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } });
  }
}
