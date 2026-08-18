import { savePaidIntent } from "../../../../lib/registration-store";
import { validatePaidIntent } from "../../../../lib/founding-validation.mjs";

export async function POST(request: Request) {
  let body: { registrationId?: unknown; intent?: unknown };
  try { body = await request.json(); } catch { return Response.json({ error: "We could not read that choice." }, { status: 400 }); }
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
