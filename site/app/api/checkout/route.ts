import { buildCheckoutRequest, isAllowedCheckoutUrl, validateCheckoutInput } from "../../../lib/payment-core.mjs";
import { createDodoClient, getPaymentConfig } from "../../../lib/dodo";
import { findReusableCheckout, getRegistrationForCheckout, saveCheckoutSession } from "../../../lib/registration-store";
import { readJsonRequest } from "../../../lib/public-boundary.mjs";
import { enforcePublicRateLimit } from "../../../lib/rate-limit";

export async function POST(request: Request) {
  const limited = await enforcePublicRateLimit(request, "checkout", 10);
  if (limited) return limited;
  const parsed = await readJsonRequest(request, 4096);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
  const input = validateCheckoutInput(parsed.data);
  if (!input.ok) return Response.json({ error: input.error }, { status: 400 });
  const configured = getPaymentConfig();
  if (!configured.ok) return Response.json({ error: "Secure checkout is being prepared. Please try again shortly." }, { status: 503 });
  try {
    const registration = await getRegistrationForCheckout(input.registrationId);
    if (!registration || registration.paidIntent !== "ready_to_pay")
      return Response.json({ error: "Registration not found." }, { status: 404 });
    const reusable = await findReusableCheckout(registration.id);
    if (reusable && isAllowedCheckoutUrl(reusable.checkoutUrl)) return Response.json({ checkoutUrl: reusable.checkoutUrl });
    const client = createDodoClient(configured.config);
    const session = await client.checkoutSessions.create(buildCheckoutRequest({
      productId: configured.config.productId,
      registrationId: registration.id,
      email: registration.email,
      publicSiteUrl: configured.config.publicSiteUrl,
    }), { idempotencyKey: `founding-${registration.id}-${new Date().toISOString().slice(0, 10)}` });
    if (!session.checkout_url || !isAllowedCheckoutUrl(session.checkout_url)) throw new Error("Invalid checkout URL");
    await saveCheckoutSession({ registrationId: registration.id, checkoutSessionId: session.session_id, checkoutUrl: session.checkout_url, productId: configured.config.productId });
    return Response.json({ checkoutUrl: session.checkout_url }, { status: 201 });
  } catch {
    return Response.json({ error: "Secure checkout is temporarily unavailable. Please try again." }, { status: 502 });
  }
}
