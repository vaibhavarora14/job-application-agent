import { unsubscribeSavedSearch } from "../../../../../lib/job-alerts.mjs";
import { jobAlertRuntime } from "../../../../../lib/job-alerts-runtime.mjs";
import { enforcePublicRateLimit } from "../../../../../lib/rate-limit";

const noStore = { "cache-control": "no-store" };

/** RFC 8058 one-click. GET does not unsubscribe, so a client prefetch leaves the row in place. */
export async function POST(request: Request) {
  const limited = await enforcePublicRateLimit(request, "job-alerts-unsubscribe", 30, 900);
  if (limited) return limited;
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const runtime = jobAlertRuntime();
  try {
    await runtime.ready;
    await unsubscribeSavedSearch(runtime.store, token);
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }
  return Response.json({ ok: true }, { headers: noStore });
}

export function GET() {
  return Response.json({ error: "method" }, { status: 405, headers: { ...noStore, allow: "POST" } });
}
