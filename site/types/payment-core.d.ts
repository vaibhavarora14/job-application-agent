declare module "*/payment-core.mjs" {
  export const FOUNDING_DODO_PRODUCT_DISPLAY: { readonly name: string; readonly description: string };
  export const FOUNDING_CTA_LABEL: "Activate founding access · $49";

  export function validateCheckoutInput(input: unknown): { ok: true; registrationId: string } | { ok: false; error: string };
  export function validatePurchaseId(input: unknown): { ok: true; purchaseId: string } | { ok: false; error: string };
  export function validatePaymentConfig(input: unknown): { ok: true; config: { apiKey: string; productId: string; webhookKey: string; environment: "test_mode" | "live_mode"; publicSiteUrl: string } } | { ok: false; error: string };
  export function buildCheckoutRequest(input: { productId: string; purchaseId: string; publicSiteUrl: string }): {
    product_cart: Array<{ product_id: string; quantity: number }>;
    return_url: string;
    cancel_url: string;
    metadata: Record<string, string>;
    customization: Record<string, unknown>;
  };
  export function isCheckoutDesignSuccess(searchParams: unknown): boolean;
  export function canonicalCheckoutReturnUrl(searchParams: unknown): string | null;
  export function normalizePaymentWebhook(payload: unknown, productId: string): { ok: true; ignored: true } | { ok: true; payment: { eventType: string; purchaseId: string | null; paymentId: string; customerId: string | null; customerEmail: string | null; status: string | null; amount: number | null; currency: string | null; productId: string; refundId?: string | null; refundStatus?: string | null } } | { ok: false; error: string };
  export function hasPaidAccess(status: unknown): boolean;
  export function isAllowedCheckoutUrl(value: unknown): boolean;
}
