declare module "*/payment-core.mjs" {
  export function validateCheckoutInput(input: unknown): { ok: true; registrationId: string } | { ok: false; error: string };
  export function validatePaymentConfig(input: unknown): { ok: true; config: { apiKey: string; productId: string; webhookKey: string; environment: "test_mode" | "live_mode"; publicSiteUrl: string } } | { ok: false; error: string };
  export function buildCheckoutRequest(input: { productId: string; registrationId: string; email: string; publicSiteUrl: string }): { product_cart: Array<{ product_id: string; quantity: number }>; customer: { email: string }; return_url: string; cancel_url: string; metadata: Record<string, string> };
  export function normalizePaymentWebhook(payload: unknown, productId: string): { ok: true; ignored: true } | { ok: true; payment: { eventType: string; registrationId: string; paymentId: string; status: string; amount: number | null; currency: string | null; productId: string } } | { ok: false; error: string };
  export function hasPaidAccess(status: unknown): boolean;
  export function isAllowedCheckoutUrl(value: unknown): boolean;
}
