import { handleJobAlertsAction, tokensMatch } from "../../../../lib/job-alerts.mjs";
import { jobAlertRuntime } from "../../../../lib/job-alerts-runtime.mjs";
import { readJsonRequest } from "../../../../lib/public-boundary.mjs";

const noStore = { "cache-control": "no-store" };

type AlertAction = "due" | "deliver" | "advance" | "purge";

function parseAction(value: unknown): AlertAction | null {
  switch (value) {
    case "due":
    case "deliver":
    case "advance":
    case "purge":
      return value;
    default:
      return null;
  }
}

export async function POST(request: Request) {
  const runtime = jobAlertRuntime();
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!await tokensMatch(runtime.cronSecret, supplied)) {
    return Response.json({ error: "unauthorized" }, { status: 401, headers: noStore });
  }
  const body = await readJsonRequest(request, 32_000);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status, headers: noStore });
  const action = parseAction(body.data?.action);
  if (!action) return Response.json({ error: "invalid_action" }, { status: 400, headers: noStore });
  try {
    await runtime.ready;
    switch (action) {
      case "due":
      case "deliver":
      case "advance":
      case "purge":
        return Response.json(
          await handleJobAlertsAction(runtime.store, runtime.mailer, { ...body.data, action }, {
            origin: runtime.origin,
            now: Date.now(),
          }),
          { headers: noStore },
        );
      default: {
        const never: never = action;
        return never;
      }
    }
  } catch {
    return Response.json({ error: "digest_failed" }, { status: 503, headers: noStore });
  }
}
