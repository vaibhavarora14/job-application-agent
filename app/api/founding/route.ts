import { saveRegistration } from "../../../lib/registration-store";
import { validateFoundingRegistration } from "../../../lib/founding-validation.mjs";

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    return Response.json({ error: "Send this form as JSON." }, { status: 415 });
  if (Number(request.headers.get("content-length") ?? 0) > 8192)
    return Response.json({ error: "That request is too large." }, { status: 413 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "We could not read that form." }, { status: 400 }); }
  const result = validateFoundingRegistration(body);
  if (!result.ok) return Response.json({ error: "Check the highlighted fields.", fields: result.errors }, { status: 400 });
  if (result.bot) return Response.json({ registrationId: crypto.randomUUID(), offer: { priceUsd: 49, accessDays: 90 } }, { status: 201 });
  try {
    const registrationId = await saveRegistration(result.data);
    return Response.json({ registrationId, offer: { priceUsd: 49, accessDays: 90 } }, { status: 201 });
  } catch {
    return Response.json({ error: "Registration is temporarily unavailable. Please try again." }, { status: 503 });
  }
}
