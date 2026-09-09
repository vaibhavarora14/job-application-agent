import { env } from "cloudflare:workers";
import { communityJobsUpstreamUrl, validateCommunityJobs } from "../../../lib/community-jobs.mjs";

const CACHE_CONTROL = "public, max-age=60, s-maxage=300, stale-while-revalidate=900";
const MAX_UPSTREAM_BYTES = 128 * 1024;

export async function GET(request: Request) {
  const configured = env.COMMUNITY_JOBS_UPSTREAM
    ?? (env.COMMUNITY_STATS_UPSTREAM ? new URL("/v1/jobs", env.COMMUNITY_STATS_UPSTREAM).toString() : null);
  if (!configured) return Response.json({ error: "jobs_unavailable" }, { status: 503, headers: { "cache-control": "no-store" } });

  let upstream;
  try { upstream = communityJobsUpstreamUrl(configured, new URL(request.url)); }
  catch { return Response.json({ error: "invalid_job_query" }, { status: 400, headers: { "cache-control": "no-store" } }); }

  try {
    const fetcher = (env as unknown as { TELEMETRY?: { fetch: typeof fetch } }).TELEMETRY?.fetch?.bind(
      (env as unknown as { TELEMETRY?: { fetch: typeof fetch } }).TELEMETRY,
    ) ?? fetch;
    const response = await fetcher(new Request(upstream, { headers: { accept: "application/json" } }));
    if (!response.ok) throw new Error("upstream unavailable");
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_UPSTREAM_BYTES) throw new Error("upstream response too large");
    const result = validateCommunityJobs(JSON.parse(raw));
    if (!result.ok) throw new Error("invalid upstream response");
    return Response.json(result.data, { headers: { "cache-control": CACHE_CONTROL, "x-content-type-options": "nosniff" } });
  } catch {
    return Response.json({ error: "jobs_unavailable" }, { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } });
  }
}
