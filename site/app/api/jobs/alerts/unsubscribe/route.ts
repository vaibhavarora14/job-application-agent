import { unsubscribeSavedSearch } from "../../../../../lib/job-alerts.mjs";
import { jobAlertRuntime } from "../../../../../lib/job-alerts-runtime.mjs";
import { enforcePublicRateLimit } from "../../../../../lib/rate-limit";

const noStore = { "cache-control": "no-store" };

async function tokenFrom(request: Request) {
  const fromQuery = new URL(request.url).searchParams.get("token") ?? "";
  if (fromQuery) return fromQuery;
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!type.includes("form")) return "";
  const form = await request.formData();
  const token = form.get("token");
  return typeof token === "string" ? token : "";
}

/** RFC 8058 one-click and the visible form. GET does not unsubscribe. */
export async function POST(request: Request) {
  const limited = await enforcePublicRateLimit(request, "job-alerts-unsubscribe", 30, 900);
  if (limited) return limited;
  const token = await tokenFrom(request);
  const runtime = jobAlertRuntime();
  try {
    await runtime.ready;
    await unsubscribeSavedSearch(runtime.store, token);
  } catch {
    return Response.json({ error: "unavailable" }, { status: 503, headers: noStore });
  }
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("form")) {
    return new Response(null, { status: 303, headers: { ...noStore, location: "/jobs/alerts/unsubscribed" } });
  }
  return Response.json({ ok: true }, { headers: noStore });
}

export function GET() {
  return Response.json({ error: "method" }, { status: 405, headers: { ...noStore, allow: "POST" } });
}
