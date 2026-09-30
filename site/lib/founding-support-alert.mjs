/**
 * Ops Support alert when a founding payment succeeds.
 * Paid ≠ activated — this notifies humans to email access details, then activate.
 */

export const DEFAULT_FOUNDING_SUPPORT_ALERT_EMAIL = "founders@jobappagent.com";

/**
 * @param {{
 *   purchaseId: string,
 *   customerEmail?: string | null,
 *   paymentId?: string | null,
 *   amount?: number | null,
 *   currency?: string | null,
 *   eventType?: string | null,
 * }} input
 */
export function buildFoundingSupportAlert(input) {
  const purchaseId = String(input?.purchaseId ?? "").trim();
  const customerEmail = typeof input?.customerEmail === "string" && input.customerEmail.trim()
    ? input.customerEmail.trim().toLowerCase()
    : null;
  const paymentId = typeof input?.paymentId === "string" && input.paymentId.trim()
    ? input.paymentId.trim()
    : null;
  const amount = typeof input?.amount === "number" && Number.isFinite(input.amount)
    ? input.amount
    : null;
  const currency = typeof input?.currency === "string" && input.currency.trim()
    ? input.currency.trim().toUpperCase()
    : null;
  const eventType = typeof input?.eventType === "string" && input.eventType.trim()
    ? input.eventType.trim()
    : "payment.succeeded";

  const subject = `[Founding] Paid — activate seat for ${customerEmail ?? "unknown email"}`;
  const lines = [
    "Founding hosted payment succeeded. Manual fulfillment required.",
    "",
    `purchaseId: ${purchaseId || "(missing)"}`,
    `buyerEmail: ${customerEmail ?? "(not provided)"}`,
    `paymentId: ${paymentId ?? "(not provided)"}`,
    amount != null ? `amount: ${amount}${currency ? ` ${currency}` : ""}` : null,
    `eventType: ${eventType}`,
    "",
    "Next steps:",
    "1. Email the buyer hosted access details (success UI promises ~24h).",
    "2. After that email is sent, manually activate the seat (see docs/FOUNDING_ACTIVATION.md).",
    "3. Do NOT treat payment as seat activation — activatePurchase stays ops-only.",
  ].filter((line) => line != null);

  const text = lines.join("\n");
  const html = [
    "<p><strong>Founding hosted payment succeeded.</strong> Manual fulfillment required.</p>",
    "<ul>",
    `<li><strong>purchaseId:</strong> ${escapeHtml(purchaseId || "(missing)")}</li>`,
    `<li><strong>buyerEmail:</strong> ${escapeHtml(customerEmail ?? "(not provided)")}</li>`,
    `<li><strong>paymentId:</strong> ${escapeHtml(paymentId ?? "(not provided)")}</li>`,
    amount != null
      ? `<li><strong>amount:</strong> ${escapeHtml(String(amount))}${currency ? ` ${escapeHtml(currency)}` : ""}</li>`
      : "",
    `<li><strong>eventType:</strong> ${escapeHtml(eventType)}</li>`,
    "</ul>",
    "<ol>",
    "<li>Email the buyer hosted access details (success UI promises ~24h).</li>",
    "<li>After that email is sent, manually activate the seat (see <code>docs/FOUNDING_ACTIVATION.md</code>).</li>",
    "<li>Do <strong>not</strong> treat payment as seat activation — <code>activatePurchase</code> stays ops-only.</li>",
    "</ol>",
  ].filter(Boolean).join("");

  return {
    subject,
    text,
    html,
    purchaseId: purchaseId || null,
    customerEmail,
    paymentId,
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Structured log line for Cloudflare Worker logs (durable even when Resend is unset).
 * @param {ReturnType<typeof buildFoundingSupportAlert>} alert
 * @param {{ logger?: { info?: Function, error?: Function, warn?: Function } }} [config]
 */
export function logFoundingSupportAlert(alert, config = {}) {
  const logger = config.logger ?? console;
  const payload = {
    type: "founding_payment_support_alert",
    purchaseId: alert.purchaseId,
    buyerEmail: alert.customerEmail,
    paymentId: alert.paymentId,
    subject: alert.subject,
  };
  logger.info?.(`[founding-support-alert] ${JSON.stringify(payload)}`);
  return payload;
}

/**
 * @param {object} input — same shape as buildFoundingSupportAlert
 * @param {{
 *   apiKey?: string,
 *   from?: string,
 *   to?: string,
 *   fetchImpl?: typeof fetch,
 *   logger?: { info?: Function, error?: Function, warn?: Function },
 * }} [config]
 */
export async function sendFoundingSupportAlert(input, config = {}) {
  const logger = config.logger ?? console;
  const alert = buildFoundingSupportAlert(input);
  const logged = logFoundingSupportAlert(alert, { logger });

  if (!alert.purchaseId) {
    logger.error?.("[founding-support-alert] purchaseId missing; skip mail");
    return { ok: false, error: "purchase_id_missing", logged };
  }

  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  const from = typeof config.from === "string" && config.from.trim()
    ? config.from.trim()
    : "JobAppAgent Ops <ops@jobappagent.com>";
  const to = typeof config.to === "string" && config.to.trim()
    ? config.to.trim().toLowerCase()
    : DEFAULT_FOUNDING_SUPPORT_ALERT_EMAIL;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!apiKey) {
    logger.warn?.("[founding-support-alert] RESEND_API_KEY missing; structured log only");
    return { ok: true, channel: "log_only", logged, subject: alert.subject };
  }
  if (!emailPattern.test(to)) {
    logger.error?.("[founding-support-alert] SUPPORT alert recipient invalid");
    return { ok: false, error: "recipient_invalid", logged };
  }

  const fetchImpl = config.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: alert.subject,
        text: alert.text,
        html: alert.html,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.error?.(`[founding-support-alert] Resend rejected (${response.status}): ${detail.slice(0, 200)}`);
      return { ok: false, error: "mailer_failed", status: response.status, logged };
    }

    const body = await response.json().catch(() => ({}));
    return {
      ok: true,
      channel: "resend",
      id: typeof body?.id === "string" ? body.id : null,
      subject: alert.subject,
      logged,
    };
  } catch (error) {
    logger.error?.(`[founding-support-alert] Resend request failed: ${error instanceof Error ? error.message : "unknown"}`);
    return { ok: false, error: "mailer_failed", logged };
  }
}
