import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckoutRequest,
  canonicalCheckoutReturnUrl,
  hasPaidAccess,
  isAllowedCheckoutUrl,
  normalizePaymentWebhook,
  validatePurchaseId,
  validatePaymentConfig,
} from "../lib/payment-core.mjs";

const purchaseId = "11111111-1111-4111-8111-111111111111";

test("accepts only a UUID purchase id for status and reuse", () => {
  assert.deepEqual(validatePurchaseId(purchaseId), { ok: true, purchaseId });
  assert.deepEqual(validatePurchaseId("../someone-else"), {
    ok: false,
    error: "Purchase not found.",
  });
});

test("requires an explicit Dodo environment and HTTPS public site URL", () => {
  assert.equal(validatePaymentConfig({}).ok, false);
  assert.equal(validatePaymentConfig({
    apiKey: "key", productId: "pdt_123", webhookKey: "whsec_123",
    environment: "test_mode", publicSiteUrl: "https://example.com",
  }).ok, true);
  assert.equal(validatePaymentConfig({
    apiKey: "key", productId: "pdt_123", webhookKey: "whsec_123",
    environment: "live_mode", publicSiteUrl: "http://example.com",
  }).ok, false);
});

test("builds a hosted checkout that collects customer details at Dodo", () => {
  assert.deepEqual(buildCheckoutRequest({
    productId: "pdt_founding", purchaseId,
    publicSiteUrl: "https://agent.example",
  }), {
    product_cart: [{ product_id: "pdt_founding", quantity: 1 }],
    return_url: `https://agent.example/checkout/return?purchase_id=${purchaseId}`,
    cancel_url: "https://agent.example/#founding",
    metadata: { purchase_id: purchaseId, offer: "founding_90_days" },
    customization: {
      force_language: "en",
      theme: "light",
      theme_config: {
        font_primary_url: "https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700&display=swap",
        font_secondary_url: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap",
        font_size: "md",
        font_weight: "medium",
        pay_button_text: "Reserve 90-day access — $49",
        radius: "0.6rem",
        light: {
          bg_primary: "#f7f9fc",
          bg_secondary: "#ffffff",
          border_primary: "#dfe5ee",
          border_secondary: "#dfe5ee",
          button_primary: "#2457d6",
          button_primary_hover: "#194bc6",
          button_secondary: "#ffffff",
          button_secondary_hover: "#eaf0ff",
          button_text_primary: "#ffffff",
          button_text_secondary: "#12213b",
          input_focus_border: "#2457d6",
          text_error: "#c84a31",
          text_placeholder: "#748198",
          text_primary: "#12213b",
          text_secondary: "#46556d",
          text_success: "#087a55",
        },
      },
    },
  });
});

test("removes Dodo buyer details from the checkout return URL", () => {
  assert.equal(canonicalCheckoutReturnUrl({
    purchase_id: purchaseId,
    payment_id: "pay_123",
    status: "succeeded",
    email: "founder@example.com",
  }), `/checkout/return?purchase_id=${purchaseId}`);
  assert.equal(canonicalCheckoutReturnUrl({ purchase_id: purchaseId }), null);
  assert.equal(canonicalCheckoutReturnUrl({ email: "founder@example.com" }), "/checkout/return");
});

test("normalizes a verified payment webhook for the configured product", () => {
  const result = normalizePaymentWebhook({
    type: "payment.succeeded",
    data: {
      payment_id: "pay_123",
      status: "succeeded",
      total_amount: 4900,
      currency: "USD",
      customer: { customer_id: "cus_123", email: "Founder@Example.com" },
      metadata: { purchase_id: purchaseId },
      product_cart: [{ product_id: "pdt_founding", quantity: 1 }],
    },
  }, "pdt_founding");
  assert.deepEqual(result, {
    ok: true,
    payment: {
      eventType: "payment.succeeded", purchaseId, paymentId: "pay_123",
      customerId: "cus_123", customerEmail: "founder@example.com",
      status: "succeeded", amount: 4900, currency: "USD", productId: "pdt_founding",
    },
  });
});

test("ignores unrelated events and rejects mismatched products", () => {
  assert.deepEqual(normalizePaymentWebhook({ type: "customer.created", data: {} }, "pdt_founding"), { ok: true, ignored: true });
  const mismatch = normalizePaymentWebhook({
    type: "payment.succeeded",
    data: { payment_id: "pay_123", metadata: { purchase_id: purchaseId }, product_cart: [{ product_id: "pdt_other", quantity: 1 }] },
  }, "pdt_founding");
  assert.deepEqual(mismatch, { ok: false, error: "Webhook product does not match the founding offer." });
});

test("normalizes refund and dispute webhooks through the stored payment reference", () => {
  assert.deepEqual(normalizePaymentWebhook({
    type: "refund.succeeded",
    data: {
      refund_id: "ref_123",
      payment_id: "pay_123",
      status: "succeeded",
      metadata: { purchase_id: purchaseId },
      customer: { customer_id: "cus_123", email: "founder@example.com" },
      amount: 4900,
      currency: "USD",
    },
  }, "pdt_founding"), {
    ok: true,
    payment: {
      eventType: "refund.succeeded", purchaseId, paymentId: "pay_123",
      customerId: "cus_123", customerEmail: "founder@example.com",
      status: "refunded", amount: null, currency: null, productId: "pdt_founding",
      refundId: "ref_123", refundStatus: "succeeded",
    },
  });

  assert.deepEqual(normalizePaymentWebhook({
    type: "dispute.opened",
    data: { payment_id: "pay_123", dispute_id: "dp_123", dispute_status: "dispute_opened" },
  }, "pdt_founding"), {
    ok: true,
    payment: {
      eventType: "dispute.opened", purchaseId: null, paymentId: "pay_123",
      customerId: null, customerEmail: null,
      status: "dispute_opened", amount: null, currency: null, productId: "pdt_founding",
      refundId: null, refundStatus: null,
    },
  });
});

test("grants access only after a succeeded webhook and revokes it after refund or dispute", () => {
  assert.equal(hasPaidAccess("succeeded"), true);
  assert.equal(hasPaidAccess("processing"), false);
  assert.equal(hasPaidAccess("refunded"), false);
  assert.equal(hasPaidAccess("dispute_opened"), false);
});

test("redirects only to an HTTPS Dodo Payments checkout host", () => {
  assert.equal(isAllowedCheckoutUrl("https://checkout.dodopayments.com/session"), true);
  assert.equal(isAllowedCheckoutUrl("https://test.checkout.dodopayments.com/session"), true);
  assert.equal(isAllowedCheckoutUrl("https://dodopayments.com.evil.example/session"), false);
  assert.equal(isAllowedCheckoutUrl("javascript:alert(1)"), false);
});
