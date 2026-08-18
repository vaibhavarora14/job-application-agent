import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckoutRequest,
  normalizePaymentWebhook,
  validateCheckoutInput,
  validatePaymentConfig,
} from "../lib/payment-core.mjs";

const registrationId = "11111111-1111-4111-8111-111111111111";

test("accepts only a UUID registration id for checkout", () => {
  assert.deepEqual(validateCheckoutInput({ registrationId }), { ok: true, registrationId });
  assert.deepEqual(validateCheckoutInput({ registrationId: "../someone-else" }), {
    ok: false,
    error: "Registration not found.",
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

test("builds a hosted checkout tied to the registration", () => {
  assert.deepEqual(buildCheckoutRequest({
    productId: "pdt_founding", registrationId, email: "founder@example.com",
    publicSiteUrl: "https://agent.example",
  }), {
    product_cart: [{ product_id: "pdt_founding", quantity: 1 }],
    customer: { email: "founder@example.com" },
    return_url: `https://agent.example/checkout/return?registration_id=${registrationId}`,
    cancel_url: "https://agent.example/#founding",
    metadata: { registration_id: registrationId, offer: "founding_90_days" },
  });
});

test("normalizes a verified payment webhook for the configured product", () => {
  const result = normalizePaymentWebhook({
    type: "payment.succeeded",
    data: {
      payment_id: "pay_123",
      status: "succeeded",
      total_amount: 4900,
      currency: "USD",
      metadata: { registration_id: registrationId },
      product_cart: [{ product_id: "pdt_founding", quantity: 1 }],
    },
  }, "pdt_founding");
  assert.deepEqual(result, {
    ok: true,
    payment: {
      eventType: "payment.succeeded", registrationId, paymentId: "pay_123",
      status: "succeeded", amount: 4900, currency: "USD", productId: "pdt_founding",
    },
  });
});

test("ignores unrelated events and rejects mismatched products", () => {
  assert.deepEqual(normalizePaymentWebhook({ type: "customer.created", data: {} }, "pdt_founding"), { ok: true, ignored: true });
  const mismatch = normalizePaymentWebhook({
    type: "payment.succeeded",
    data: { payment_id: "pay_123", metadata: { registration_id: registrationId }, product_cart: [{ product_id: "pdt_other", quantity: 1 }] },
  }, "pdt_founding");
  assert.deepEqual(mismatch, { ok: false, error: "Webhook product does not match the founding offer." });
});
