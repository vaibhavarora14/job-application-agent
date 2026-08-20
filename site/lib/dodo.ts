import { env } from "cloudflare:workers";
import DodoPayments from "dodopayments";
import { validatePaymentConfig } from "./payment-core.mjs";

export function getPaymentConfig() {
  return validatePaymentConfig({
    apiKey: env.DODO_PAYMENTS_API_KEY,
    webhookKey: env.DODO_PAYMENTS_WEBHOOK_KEY,
    productId: env.DODO_PRODUCT_ID,
    environment: env.DODO_PAYMENTS_ENVIRONMENT,
    publicSiteUrl: env.PUBLIC_SITE_URL,
  });
}

export function createDodoClient(config: { apiKey: string; webhookKey: string; environment: "test_mode" | "live_mode" }) {
  return new DodoPayments({
    bearerToken: config.apiKey,
    webhookKey: config.webhookKey,
    environment: config.environment,
    maxRetries: 0,
    timeout: 10_000,
  });
}
