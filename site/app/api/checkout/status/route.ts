import { getLatestPaymentStatus } from "../../../../lib/registration-store";
import { hasPaidAccess, validateCheckoutInput } from "../../../../lib/payment-core.mjs";
import { enforcePublicRateLimit } from "../../../../lib/rate-limit";

export async function GET(request: Request) {
  const limited = await enforcePublicRateLimit(request, "checkout_status", 120);
  if (limited) return limited;
  const registrationId = new URL(request.url).searchParams.get("registration_id");
  const input = validateCheckoutInput({ registrationId });
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  try {
    const payment = await getLatestPaymentStatus(input.registrationId);
    return Response.json({ status: payment?.status ?? "not_started", paid: hasPaidAccess(payment?.status) }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Payment status is temporarily unavailable." }, { status: 503 });
  }
}
