import { env } from "cloudflare:workers";
import { createDodoClient, getPaymentConfig } from "../../../../lib/dodo";
import { normalizePaymentWebhook } from "../../../../lib/payment-core.mjs";
import {
  FOUNDING_EVENTS,
  captureSitePostHogEvent,
  foundingEventProperties,
} from "../../../../lib/posthog.mjs";
import { applyPurchaseWebhook } from "../../../../lib/registration-store";
import { readTextRequest } from "../../../../lib/public-boundary.mjs";
import { captureRouteError } from "../../../../lib/sentry.mjs";

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
    if (normalized.payment.status === "succeeded" && normalized.payment.purchaseId) {
      const properties = await foundingEventProperties(normalized.payment.purchaseId, {
        status: "succeeded",
        amount: normalized.payment.amount,
        currency: normalized.payment.currency,
        eventType: normalized.payment.eventType,
      });
      void captureSitePostHogEvent(env, {
        event: FOUNDING_EVENTS.PAYMENT_CONFIRMED,
        distinctId: String(properties.purchaseIdHash),
        properties,
      });
    }
    return Response.json({ received: true });
  } catch (error) {
    captureRouteError(error, { route: "/api/webhooks/dodo", status: 503 });
    return Response.json({ error: "Webhook could not be persisted." }, { status: 503 });
  }
}
