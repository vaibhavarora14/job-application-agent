import { createDodoClient, getPaymentConfig } from "../../../../lib/dodo";
import { normalizePaymentWebhook } from "../../../../lib/payment-core.mjs";
import {
  applyPurchaseWebhook,
  claimWelcomeEmailDelivery,
  getWelcomeEmailPurchase,
  markWelcomeEmailAccepted,
  markWelcomeEmailFailed,
} from "../../../../lib/registration-store";
import { getWelcomeEmailConfig, sendWelcomeEmail } from "../../../../lib/resend";
import { readTextRequest } from "../../../../lib/public-boundary.mjs";
import { deliverPurchaseWelcome } from "../../../../lib/welcome-email.mjs";

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
    await applyPurchaseWebhook(webhookHeaders["webhook-id"], normalized.payment);
    if (normalized.payment.eventType === "payment.succeeded") {
      const emailConfig = getWelcomeEmailConfig();
      const purchase = normalized.payment.purchaseId
        ? await getWelcomeEmailPurchase(normalized.payment.purchaseId)
        : null;
      if (!emailConfig.ok || !emailConfig.config || !purchase) throw new Error("Welcome email is unavailable.");
      const welcomeConfig = emailConfig.config;
      const delivered = await deliverPurchaseWelcome({
        purchase,
        config: welcomeConfig,
        claimDelivery: claimWelcomeEmailDelivery,
        sendEmail: (message: Parameters<typeof sendWelcomeEmail>[1], options: Parameters<typeof sendWelcomeEmail>[2]) =>
          sendWelcomeEmail(welcomeConfig, message, options),
        markAccepted: markWelcomeEmailAccepted,
        markFailed: markWelcomeEmailFailed,
      });
      if (!delivered.ok) throw new Error("Welcome email delivery failed.");
    }
    return Response.json({ received: true });
  } catch {
    return Response.json({ error: "Webhook fulfillment is temporarily unavailable." }, { status: 503 });
  }
}
