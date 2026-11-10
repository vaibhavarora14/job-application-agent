import { readJsonRequest } from "../../../../lib/public-boundary.mjs";
import { subscribeSavedSearch } from "../../../../lib/job-alerts.mjs";
import { jobAlertRuntime } from "../../../../lib/job-alerts-runtime.mjs";
import { enforcePublicRateLimit } from "../../../../lib/rate-limit";

const noStore = { "cache-control": "no-store" };

type SubscribeError = "invalid_email" | "invalid_cadence" | "invalid_query" | "too_many" | "alerts_disabled" | "mail_failed";

function subscribeError(code: SubscribeError): { status: number; error: string } {
  switch (code) {
    case "invalid_email":
      return { status: 400, error: "Enter a valid email address." };
    case "invalid_cadence":
      return { status: 400, error: "Choose daily or weekly." };
    case "invalid_query":
      return { status: 400, error: "Those filters could not be saved." };
    case "too_many":
      return { status: 429, error: "Too many saved searches for this email." };
    case "alerts_disabled":
      return { status: 503, error: "Email alerts are not available yet." };
    case "mail_failed":
      return { status: 503, error: "Couldn't send the confirmation. Try again." };
    default: {
      const never: never = code;
      return never;
    }
  }
}

function isSubscribeError(value: string): value is SubscribeError {
  switch (value) {
    case "invalid_email":
    case "invalid_cadence":
    case "invalid_query":
    case "too_many":
    case "alerts_disabled":
    case "mail_failed":
      return true;
    default:
      return false;
  }
}

export async function POST(request: Request) {
  const limited = await enforcePublicRateLimit(request, "job-alerts-subscribe", 8, 900);
  if (limited) return limited;
  const body = await readJsonRequest(request, 2048);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status, headers: noStore });
  const runtime = jobAlertRuntime();
  try {
    await runtime.ready;
    const result = await subscribeSavedSearch(runtime.store, runtime.mailer, {
      email: body.data?.email,
      cadence: body.data?.cadence,
      filterQuery: body.data?.filterQuery ?? "",
      company: body.data?.company,
      origin: runtime.origin,
      now: Date.now(),
    });
    if (!result.ok) {
      const raw = result.error ?? "";
      const code = isSubscribeError(raw) ? raw : "mail_failed";
      const mapped = subscribeError(code);
      return Response.json({ error: mapped.error }, { status: mapped.status, headers: noStore });
    }
    return Response.json({ ok: true, state: result.state }, { headers: noStore });
  } catch {
    return Response.json({ error: "Couldn't save this search." }, { status: 503, headers: noStore });
  }
}
