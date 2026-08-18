import { buildCheckoutRequest, isAllowedCheckoutUrl, validateCheckoutInput } from "../../../lib/payment-core.mjs";
import { createDodoClient, getPaymentConfig } from "../../../lib/dodo";
import { findReusableCheckout, getRegistrationForCheckout, saveCheckoutSession } from "../../../lib/registration-store";

export async function POST(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    return Response.json({ error: "Send this request as JSON." }, { status: 415 });
  if (Number(request.headers.get("content-length") ?? 0) > 4096)
    return Response.json({ error: "That request is too large." }, { status: 413 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "We could not read that request." }, { status: 400 }); }
  const input = validateCheckoutInput(body);
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
