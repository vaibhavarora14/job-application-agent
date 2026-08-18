import { createDodoClient, getPaymentConfig } from "../../../../lib/dodo";
import { normalizePaymentWebhook } from "../../../../lib/payment-core.mjs";
import { applyPaymentWebhook } from "../../../../lib/registration-store";
import { readTextRequest } from "../../../../lib/public-boundary.mjs";

export async function POST(request: Request) {
  const body = await readTextRequest(request, 1_048_576);
  if (!body.ok) return Response.json({ error: body.error }, { status: body.status });
  const configured = getPaymentConfig();
  if (!configured.ok) return Response.json({ error: "Webhook is not configured." }, { status: 503 });
  const webhookHeaders = {
    "webhook-id": request.headers.get("webhook-id") ?? "",
    "webhook-signature": request.headers.get("webhook-signature") ?? "",
    "webhook-timestamp": request.headers.get("webhook-timestamp") ?? "",
  };
  let verified: unknown;
  try {
    verified = createDodoClient(configured.config).webhooks.unwrap(body.data, { headers: webhookHeaders, key: configured.config.webhookKey });
  } catch {
    return Response.json({ error: "Invalid webhook signature." }, { status: 401 });
  }
  const normalized = normalizePaymentWebhook(verified, configured.config.productId);
  if (!normalized.ok || "ignored" in normalized || !normalized.payment) return Response.json({ received: true, ignored: true });
  try {
    await applyPaymentWebhook(webhookHeaders["webhook-id"], normalized.payment);
    return Response.json({ received: true });
  } catch {
    return Response.json({ error: "Webhook could not be persisted." }, { status: 503 });
  }
}
