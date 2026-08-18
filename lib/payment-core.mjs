const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paymentEvents = new Set([
  "payment.succeeded", "payment.failed", "payment.processing", "payment.cancelled",
  "refund.succeeded", "dispute.opened", "dispute.accepted", "dispute.lost",
  "dispute.cancelled", "dispute.won", "dispute.expired", "dispute.challenged",
]);

export function validatePurchaseId(input) {
  const purchaseId = typeof input === "string" ? input.trim() : "";
  return uuidPattern.test(purchaseId)
    ? { ok: true, purchaseId }
    : { ok: false, error: "Purchase not found." };
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

export function buildCheckoutRequest({ productId, purchaseId, publicSiteUrl }) {
  const base = new URL(publicSiteUrl).origin;
  return {
    product_cart: [{ product_id: productId, quantity: 1 }],
    return_url: `${base}/checkout/return?purchase_id=${purchaseId}`,
    cancel_url: `${base}/#founding`,
    metadata: { purchase_id: purchaseId, offer: "founding_90_days" },
  };
}

export function hasPaidAccess(status) {
  return status === "succeeded";
}

export function isAllowedCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "dodopayments.com" || url.hostname.endsWith(".dodopayments.com"));
  } catch {
    return false;
  }
}

export function normalizePaymentWebhook(payload, expectedProductId) {
  const eventType = typeof payload?.type === "string" ? payload.type : payload?.event_type;
  if (!paymentEvents.has(eventType)) return { ok: true, ignored: true };
  const data = payload?.data?.object ?? payload?.data;
  const purchaseId = data?.metadata?.purchase_id;
  const productId = data?.product_cart?.find((item) => item?.product_id === expectedProductId)?.product_id;
  if (!productId) return { ok: false, error: "Webhook product does not match the founding offer." };
  if (!uuidPattern.test(purchaseId ?? "") || typeof data?.payment_id !== "string") return { ok: false, error: "Webhook is missing a valid payment reference." };
  const customerEmail = typeof data?.customer?.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.customer.email)
    ? data.customer.email.toLowerCase()
    : null;
  const customerId = typeof data?.customer?.customer_id === "string" ? data.customer.customer_id : null;
  const status = eventType === "refund.succeeded" ? "refunded"
    : eventType.startsWith("dispute.") ? `dispute_${eventType.split(".")[1]}`
    : eventType.split(".")[1];
  return { ok: true, payment: {
    eventType, purchaseId, paymentId: data.payment_id, customerId, customerEmail, status,
    amount: Number.isInteger(data.total_amount) ? data.total_amount : null,
    currency: typeof data.currency === "string" ? data.currency.toUpperCase() : null,
    productId,
  } };
}
