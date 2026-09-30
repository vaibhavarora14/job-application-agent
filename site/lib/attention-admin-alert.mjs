/**
 * Ops seam, invoked synchronously by authenticated notify before any buyer email.
 * STUB: emits a minimal operational log, not a delivered notification. Wire a
 * private ops dispatcher here before relying on paging. No buyer data, answers,
 * tokens, session URLs, telemetry or community Worker calls.
 */
export function recordAttentionAdminAlert(input, { logger = console } = {}) {
  const alert = {
    type: "attention_admin_alert",
    attentionId: input.attentionId,
    blocker: input.blocker,
    status: "stubbed",
    buyerState: "in_progress",
  };
  logger.warn?.(`[attention-admin-alert] ${JSON.stringify(alert)}`);
  return alert;
}
