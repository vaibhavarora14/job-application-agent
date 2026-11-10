import { confirmSavedSearch } from "../../../../../lib/job-alerts.mjs";
import { jobAlertRuntime } from "../../../../../lib/job-alerts-runtime.mjs";
import { readJsonRequest } from "../../../../../lib/public-boundary.mjs";
import { enforcePublicRateLimit } from "../../../../../lib/rate-limit";

const noStore = { "cache-control": "no-store" };

async function tokenFrom(request: Request) {
  const type = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("application/json")) {
    const body = await readJsonRequest(request, 2048);
    if (!body.ok) return "";
    return typeof body.data?.token === "string" ? body.data.token : "";
  }
  if (type.includes("form")) {
    const form = await request.formData();
    const token = form.get("token");
    return typeof token === "string" ? token : "";
  }
  return "";
}

export async function POST(request: Request) {
  const limited = await enforcePublicRateLimit(request, "job-alerts-confirm", 30, 900);
  if (limited) return limited;
  const token = await tokenFrom(request);
  const runtime = jobAlertRuntime();
  let confirmed = false;
  try {
    await runtime.ready;
    confirmed = (await confirmSavedSearch(runtime.store, token, Date.now())).ok;
  } catch {
    confirmed = false;
  }
  if (request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return Response.json(
      confirmed ? { ok: true } : { error: "This link is no longer valid." },
      { status: confirmed ? 200 : 400, headers: noStore },
    );
  }
  return new Response(null, {
    status: 303,
    headers: { ...noStore, location: confirmed ? "/jobs/alerts/confirmed" : "/jobs/alerts/confirm?error=1" },
  });
}
