import { savePaidIntent } from "../../../../lib/registration-store";
import { validatePaidIntent } from "../../../../lib/founding-validation.mjs";
import { readJsonRequest } from "../../../../lib/public-boundary.mjs";
import { enforcePublicRateLimit } from "../../../../lib/rate-limit";

export async function POST(request: Request) {
  const limited = await enforcePublicRateLimit(request, "founding_intent", 20);
  if (limited) return limited;
  const parsed = await readJsonRequest(request, 4096);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
  const body = parsed.data as { registrationId?: unknown; intent?: unknown };
  const id = typeof body.registrationId === "string" ? body.registrationId : "";
  const choice = validatePaidIntent(body.intent);
  if (!id || !choice.ok) return Response.json({ error: choice.ok ? "Registration not found." : choice.error }, { status: 400 });
  try {
    const saved = await savePaidIntent(id, choice.intent);
    return saved ? Response.json({ saved: true }) : Response.json({ error: "Registration not found." }, { status: 404 });
  } catch {
    return Response.json({ error: "We could not save that choice yet." }, { status: 503 });
  }
}
