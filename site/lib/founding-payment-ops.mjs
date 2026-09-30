/**
 * Founding money-path ops after a verified Dodo webhook.
 *
 * Option A: persist paid/succeeded in D1 + alert Support.
 * Seat mint (`activatePurchase`) stays unwired — paid ≠ activated.
 */

/**
 * @param {{
 *   eventId: string,
 *   payment: {
 *     eventType: string,
 *     purchaseId: string | null,
 *     paymentId: string,
 *     customerEmail?: string | null,
 *     status: string | null,
 *     amount?: number | null,
 *     currency?: string | null,
 *     [key: string]: unknown,
 *   },
 *   persist: (eventId: string, payment: {
 *     eventType: string,
 *     purchaseId: string | null,
 *     paymentId: string,
 *     customerEmail?: string | null,
 *     status: string | null,
 *     amount?: number | null,
 *     currency?: string | null,
 *     [key: string]: unknown,
 *   }) => Promise<{ isNewEvent?: boolean } | void>,
 *   alertSupport: (input: {
 *     purchaseId: string,
 *     customerEmail: string | null,
 *     paymentId: string | null,
 *     amount: number | null,
 *     currency: string | null,
 *     eventType: string,
 *   }) => Promise<unknown>,
 *   activatePurchase?: (purchaseId: string) => Promise<unknown>,
 * }} deps
 */
export async function handleFoundingPaymentWebhook(deps) {
  const { eventId, payment, persist, alertSupport } = deps;
  if (typeof deps.activatePurchase === "function") {
    // Hard guard: callers must not pass seat mint into this path.
    throw new Error("activatePurchase must not be wired into the founding payment webhook path.");
  }

  const persistResult = await persist(eventId, payment) ?? {};
  const isNewEvent = persistResult.isNewEvent !== false;

  /** @type {unknown} */
  let alert = null;
  if (payment.status === "succeeded" && payment.purchaseId && isNewEvent) {
    alert = await alertSupport({
      purchaseId: payment.purchaseId,
      customerEmail: payment.customerEmail ?? null,
      paymentId: payment.paymentId ?? null,
      amount: typeof payment.amount === "number" ? payment.amount : null,
      currency: typeof payment.currency === "string" ? payment.currency : null,
      eventType: payment.eventType,
    });
  }

  return {
    purchaseUpdated: true,
    activated: false,
    isNewEvent,
    alert,
  };
}
