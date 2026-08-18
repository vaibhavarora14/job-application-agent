import { createDodoClient } from "./dodo";
import { listRefundDue, recordRefundRequest } from "./registration-store";

export async function refundOverduePurchases(config: { apiKey: string; webhookKey: string; environment: "test_mode" | "live_mode" }) {
  const client = createDodoClient(config);
  const purchases = await listRefundDue();
  const result = { reviewed: purchases.length, requested: 0, failed: 0 };
  for (const purchase of purchases) {
    try {
      const refund = await client.refunds.create({
        payment_id: purchase.paymentId,
        reason: "Cloud access was not activated within the promised 60-day window.",
        metadata: { purchase_id: purchase.id, reason: "activation_deadline" },
      }, { idempotencyKey: `activation-deadline-${purchase.id}` });
      await recordRefundRequest(purchase.id, { refundId: refund.refund_id, status: refund.status });
      result.requested += 1;
    } catch {
      await recordRefundRequest(purchase.id, { refundId: null, status: "failed" });
      result.failed += 1;
    }
  }
  return result;
}
