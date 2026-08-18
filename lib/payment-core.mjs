const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paymentEvents = new Set([
  "payment.succeeded", "payment.failed", "payment.processing", "payment.cancelled",
  "refund.succeeded", "dispute.opened", "dispute.accepted", "dispute.lost",
  "dispute.cancelled", "dispute.won", "dispute.expired", "dispute.challenged",
]);

export function validateCheckoutInput(input) {
  const registrationId = typeof input?.registrationId === "string" ? input.registrationId.trim() : "";
  return uuidPattern.test(registrationId)
    ? { ok: true, registrationId }
    : { ok: false, error: "Registration not found." };
}

export function validatePaymentConfig(input) {
  if (!input?.apiKey || !input?.productId || !input?.webhookKey) return { ok: false, error: "Payments are not configured." };
  if (input.environment !== "test_mode" && input.environment !== "live_mode") return { ok: false, error: "Payments are not configured." };
  try {
    const url = new URL(input.publicSiteUrl);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error();
    return { ok: true, config: { ...input, publicSiteUrl: url.origin } };
  } catch {
    return { ok: false, error: "Payments are not configured." };
  }
}

export function buildCheckoutRequest({ productId, registrationId, email, publicSiteUrl }) {
  const base = new URL(publicSiteUrl).origin;
  return {
    product_cart: [{ product_id: productId, quantity: 1 }],
    customer: { email },
    return_url: `${base}/checkout/return?registration_id=${registrationId}`,
    cancel_url: `${base}/#founding`,
    metadata: { registration_id: registrationId, offer: "founding_90_days" },
  };
}

export function normalizePaymentWebhook(payload, expectedProductId) {
  const eventType = typeof payload?.type === "string" ? payload.type : payload?.event_type;
  if (!paymentEvents.has(eventType)) return { ok: true, ignored: true };
  const data = payload?.data?.object ?? payload?.data;
  const registrationId = data?.metadata?.registration_id;
  const productId = data?.product_cart?.find((item) => item?.product_id === expectedProductId)?.product_id;
  if (!productId) return { ok: false, error: "Webhook product does not match the founding offer." };
  if (!uuidPattern.test(registrationId ?? "") || typeof data?.payment_id !== "string") return { ok: false, error: "Webhook is missing a valid payment reference." };
  const status = eventType === "refund.succeeded" ? "refunded"
    : eventType.startsWith("dispute.") ? `dispute_${eventType.split(".")[1]}`
    : eventType.split(".")[1];
  return { ok: true, payment: {
    eventType, registrationId, paymentId: data.payment_id, status,
    amount: Number.isInteger(data.total_amount) ? data.total_amount : null,
    currency: typeof data.currency === "string" ? data.currency.toUpperCase() : null,
    productId,
  } };
}
