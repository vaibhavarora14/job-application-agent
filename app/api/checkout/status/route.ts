import { hasPaidAccess, validatePurchaseId } from "../../../../lib/payment-core.mjs";
import { getPurchaseStatus } from "../../../../lib/registration-store";
import { enforcePublicRateLimit } from "../../../../lib/rate-limit";

export async function GET(request: Request) {
  const limited = await enforcePublicRateLimit(request, "checkout_status", 120);
  if (limited) return limited;
  const input = validatePurchaseId(new URL(request.url).searchParams.get("purchase_id"));
  if (!input.ok || !input.purchaseId) return Response.json({ error: input.error }, { status: 400 });
  try {
    const purchase = await getPurchaseStatus(input.purchaseId);
    if (!purchase) return Response.json({ error: "Purchase not found." }, { status: 404 });
    const refunding = purchase.refundStatus && purchase.refundStatus !== "failed";
    return Response.json({
      status: purchase.status,
      paid: hasPaidAccess(purchase.status) && !refunding,
      activatedAt: purchase.activatedAt,
      accessExpiresAt: purchase.accessExpiresAt,
      activationDeadlineAt: purchase.activationDeadlineAt,
    }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Payment status is temporarily unavailable." }, { status: 503 });
  }
}
