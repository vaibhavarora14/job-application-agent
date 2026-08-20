const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const paymentEvents = new Set([
  "payment.succeeded", "payment.failed", "payment.processing", "payment.cancelled",
  "refund.succeeded", "refund.failed", "dispute.opened", "dispute.accepted", "dispute.lost",
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

/**
 * @param {{ productId: string; purchaseId: string; publicSiteUrl: string }} input
 * @returns {import("dodopayments/resources/checkout-sessions").CheckoutSessionCreateParams}
 */
export function buildCheckoutRequest({ productId, purchaseId, publicSiteUrl }) {
  const base = new URL(publicSiteUrl).origin;
  return {
    product_cart: [{ product_id: productId, quantity: 1 }],
    return_url: `${base}/checkout/return?purchase_id=${purchaseId}`,
    cancel_url: `${base}/#founding`,
    metadata: { purchase_id: purchaseId, offer: "founding_30_days" },
    customization: {
      force_language: "en",
      theme: "light",
      theme_config: {
        font_primary_url: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&display=swap",
        font_secondary_url: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap",
        font_size: "md",
        font_weight: "medium",
        pay_button_text: "Reserve at pre-launch price",
        radius: "0.6rem",
        light: {
          bg_primary: "#f7f9fc",
          bg_secondary: "#ffffff",
          border_primary: "#dfe5ee",
          border_secondary: "#dfe5ee",
          button_primary: "#2457d6",
          button_primary_hover: "#194bc6",
          button_secondary: "#ffffff",
          button_secondary_hover: "#eaf0ff",
          button_text_primary: "#ffffff",
          button_text_secondary: "#12213b",
          input_focus_border: "#2457d6",
          text_error: "#c84a31",
          text_placeholder: "#748198",
          text_primary: "#12213b",
          text_secondary: "#46556d",
          text_success: "#087a55",
        },
      },
    },
  };
}

export function canonicalCheckoutReturnUrl(searchParams) {
  const params = searchParams && typeof searchParams === "object" ? searchParams : {};
  const entries = Object.entries(params).filter(([, value]) => value !== undefined);
  const rawPurchaseId = params.purchase_id;
  const purchaseId = Array.isArray(rawPurchaseId) ? rawPurchaseId[0] : rawPurchaseId;
  const validated = validatePurchaseId(purchaseId ?? "");
  const alreadyCanonical = entries.length === 1
    && entries[0][0] === "purchase_id"
    && typeof rawPurchaseId === "string"
    && validated.ok;
  if (alreadyCanonical) return null;
  if (validated.ok) return `/checkout/return?purchase_id=${encodeURIComponent(validated.purchaseId)}`;
  return entries.length > 0 ? "/checkout/return" : null;
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
  const isPaymentEvent = eventType.startsWith("payment.");
  const isRefundEvent = eventType.startsWith("refund.");
  const rawPurchaseId = data?.metadata?.purchase_id;
  const purchaseId = uuidPattern.test(rawPurchaseId ?? "") ? rawPurchaseId : null;
  if (isPaymentEvent && !data?.product_cart?.some((item) => item?.product_id === expectedProductId)) {
    return { ok: false, error: "Webhook product does not match the founding offer." };
  }
  if ((isPaymentEvent && !purchaseId) || typeof data?.payment_id !== "string") {
    return { ok: false, error: "Webhook is missing a valid payment reference." };
  }
  const customerEmail = typeof data?.customer?.email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.customer.email)
    ? data.customer.email.toLowerCase()
    : null;
  const customerId = typeof data?.customer?.customer_id === "string" ? data.customer.customer_id : null;
  const status = eventType === "refund.succeeded" ? "refunded"
    : eventType === "refund.failed" ? null
    : eventType.startsWith("dispute.") ? `dispute_${eventType.split(".")[1]}`
    : eventType.split(".")[1];
  const payment = {
    eventType, purchaseId, paymentId: data.payment_id, customerId, customerEmail, status,
    amount: isPaymentEvent && Number.isInteger(data.total_amount) ? data.total_amount : null,
    currency: isPaymentEvent && typeof data.currency === "string" ? data.currency.toUpperCase() : null,
    productId: expectedProductId,
  };
  if (!isRefundEvent && !eventType.startsWith("dispute.")) return { ok: true, payment };
  return { ok: true, payment: {
    ...payment,
    refundId: isRefundEvent && typeof data.refund_id === "string" ? data.refund_id : null,
    refundStatus: isRefundEvent ? eventType.split(".")[1] : null,
  } };
}
