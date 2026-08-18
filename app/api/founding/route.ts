import { saveRegistration } from "../../../lib/registration-store";
import { validateFoundingRegistration } from "../../../lib/founding-validation.mjs";
import { readJsonRequest } from "../../../lib/public-boundary.mjs";
import { enforcePublicRateLimit } from "../../../lib/rate-limit";

export async function POST(request: Request) {
  const limited = await enforcePublicRateLimit(request, "founding", 10);
  if (limited) return limited;
  const parsed = await readJsonRequest(request, 8192);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
  const result = validateFoundingRegistration(parsed.data);
  if (!result.ok) return Response.json({ error: "Check the highlighted fields.", fields: result.errors }, { status: 400 });
  if (result.bot || !result.data) return Response.json({ registrationId: crypto.randomUUID(), offer: { priceUsd: 49, accessDays: 90 } }, { status: 201 });
  try {
    const registrationId = await saveRegistration(result.data);
    return Response.json({ registrationId, offer: { priceUsd: 49, accessDays: 90 } }, { status: 201 });
  } catch {
    return Response.json({ error: "Registration is temporarily unavailable. Please try again." }, { status: 503 });
  }
}
