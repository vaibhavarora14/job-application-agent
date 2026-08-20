import { CURRENT_ACCESS_DAYS, buildCheckoutRequest, isAllowedCheckoutUrl, validatePurchaseId } from "../../../lib/payment-core.mjs";
import { createDodoClient, getPaymentConfig } from "../../../lib/dodo";
import { createPurchase, findReusablePurchase, savePurchaseCheckout } from "../../../lib/registration-store";
import { enforcePublicRateLimit } from "../../../lib/rate-limit";

const COOKIE_NAME = "founding_purchase";

function purchaseCookie(request: Request) {
  const value = request.headers.get("cookie")?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === COOKIE_NAME)?.[1];
  const parsed = validatePurchaseId(value ?? "");
  return parsed.ok ? parsed.purchaseId : null;
}

function cookieHeader(purchaseId: string) {
  return `${COOKIE_NAME}=${purchaseId}; Path=/; Max-Age=86400; HttpOnly; Secure; SameSite=Lax`;
}

export async function POST(request: Request) {
  const limited = await enforcePublicRateLimit(request, "checkout", 10);
  if (limited) return limited;
  const configured = getPaymentConfig();
  if (!configured.ok) return Response.json({ error: "Secure checkout is being prepared. Please try again shortly." }, { status: 503 });
  try {
    const existingId = purchaseCookie(request);
    const reusable = existingId ? await findReusablePurchase(existingId) : null;
    if (reusable && isAllowedCheckoutUrl(reusable.checkoutUrl)) {
      return Response.json({ purchaseId: reusable.id, checkoutUrl: reusable.checkoutUrl }, { headers: { "set-cookie": cookieHeader(reusable.id) } });
    }
    const purchaseId = await createPurchase(configured.config.productId, CURRENT_ACCESS_DAYS);
    const client = createDodoClient(configured.config);
    const session = await client.checkoutSessions.create(buildCheckoutRequest({
      productId: configured.config.productId,
      purchaseId,
      publicSiteUrl: configured.config.publicSiteUrl,
    }), { idempotencyKey: `founding-${purchaseId}` });
    if (!session.checkout_url || !isAllowedCheckoutUrl(session.checkout_url)) throw new Error("Invalid checkout URL");
    const saved = await savePurchaseCheckout({ purchaseId, checkoutSessionId: session.session_id, checkoutUrl: session.checkout_url });
    if (!saved) throw new Error("Checkout could not be persisted");
    return Response.json({ purchaseId, checkoutUrl: session.checkout_url }, {
      status: 201,
      headers: { "set-cookie": cookieHeader(purchaseId) },
    });
  } catch {
    return Response.json({ error: "Secure checkout is temporarily unavailable. Please try again." }, { status: 502 });
  }
}
