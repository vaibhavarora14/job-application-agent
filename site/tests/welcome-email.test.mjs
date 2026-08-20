import assert from "node:assert/strict";
import test from "node:test";

import {
  WELCOME_MESSAGE_KIND,
  buildWelcomeEmail,
  deliverPurchaseWelcome,
  validateWelcomeEmailConfig,
} from "../lib/welcome-email.mjs";

const config = {
  apiKey: "re_jobappagent",
  from: "Vaibhav at JobAppAgent <vaibhav@updates.jobappagent.com>",
  replyTo: "support@jobappagent.com",
};

function purchase(accessDays = 90) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    customerEmail: "customer@example.com",
    accessDays,
    status: "succeeded",
  };
}

test("validates complete server-only welcome email configuration", () => {
  assert.equal(validateWelcomeEmailConfig({}).ok, false);
  assert.equal(validateWelcomeEmailConfig({ ...config, apiKey: "public" }).ok, false);
  assert.equal(validateWelcomeEmailConfig({ ...config, replyTo: "not-an-email" }).ok, false);
  assert.deepEqual(validateWelcomeEmailConfig(config), { ok: true, config });
});

test("renders equivalent 90-day HTML and plain-text purchase terms", () => {
  const message = buildWelcomeEmail(purchase(90), config);
  assert.equal(message.subject, "Welcome to JobAppAgent — your reservation is confirmed");
  assert.equal(message.to, "customer@example.com");
  assert.equal(message.from, config.from);
  assert.equal(message.replyTo, config.replyTo);
  for (const copy of [message.text, message.html]) {
    assert.match(copy, /90 days of access/);
    assert.match(copy, /September 18, 2026/);
    assert.match(copy, /within 60 days of payment/);
    assert.match(copy, /support@jobappagent\.com/);
    assert.match(copy, /applying to the right roles/);
    assert.match(copy, /one-time transactional email/);
  }
  assert.doesNotMatch(message.html, /<img\b/i);
});

test("renders the stored 30-day entitlement without changing the surrounding promise", () => {
  const message = buildWelcomeEmail(purchase(30), config);
  assert.match(message.text, /30 days of access/);
  assert.match(message.html, /30 days of access/);
  assert.doesNotMatch(message.text, /90 days of access/);
});

test("accepts a succeeded purchase once with a stable idempotency key", async () => {
  const calls = [];
  const result = await deliverPurchaseWelcome({
    purchase: purchase(),
    config,
    claimDelivery: async (input) => { calls.push(["claim", input]); return true; },
    sendEmail: async (message, options) => { calls.push(["send", message, options]); return { id: "email_123" }; },
    markAccepted: async (input) => { calls.push(["accepted", input]); return true; },
    markFailed: async (input) => { calls.push(["failed", input]); },
  });

  assert.deepEqual(result, { ok: true, sent: true, providerMessageId: "email_123" });
  assert.deepEqual(calls[0], ["claim", { purchaseId: purchase().id, messageKind: WELCOME_MESSAGE_KIND }]);
  assert.deepEqual(calls[1][2], { idempotencyKey: `${WELCOME_MESSAGE_KIND}/${purchase().id}` });
  assert.deepEqual(calls[2], ["accepted", {
    purchaseId: purchase().id,
    messageKind: WELCOME_MESSAGE_KIND,
    providerMessageId: "email_123",
  }]);
  assert.equal(calls.some(([name]) => name === "failed"), false);
});

test("skips a webhook replay when the delivery cannot be claimed", async () => {
  let sends = 0;
  const result = await deliverPurchaseWelcome({
    purchase: purchase(),
    config,
    claimDelivery: async () => false,
    sendEmail: async () => { sends += 1; return { id: "email_123" }; },
    markAccepted: async () => true,
    markFailed: async () => {},
  });
  assert.deepEqual(result, { ok: true, sent: false, duplicate: true });
  assert.equal(sends, 0);
});

test("allows only one concurrent delivery claim to send", async () => {
  let claimed = false;
  let sends = 0;
  const dependencies = {
    purchase: purchase(),
    config,
    claimDelivery: async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    },
    sendEmail: async () => { sends += 1; return { id: "email_123" }; },
    markAccepted: async () => true,
    markFailed: async () => {},
  };
  const results = await Promise.all([
    deliverPurchaseWelcome(dependencies),
    deliverPurchaseWelcome(dependencies),
  ]);
  assert.equal(sends, 1);
  assert.equal(results.filter((result) => result.sent).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 1);
});

test("marks a provider failure as retryable without exposing its details", async () => {
  const failed = [];
  const result = await deliverPurchaseWelcome({
    purchase: purchase(),
    config,
    claimDelivery: async () => true,
    sendEmail: async () => { throw new Error("provider included customer@example.com in error"); },
    markAccepted: async () => assert.fail("must not accept a failed send"),
    markFailed: async (input) => { failed.push(input); },
  });
  assert.deepEqual(result, { ok: false, error: "delivery_failed" });
  assert.deepEqual(failed, [{ purchaseId: purchase().id, messageKind: WELCOME_MESSAGE_KIND }]);
});

test("retries when provider acceptance cannot be persisted", async () => {
  let failures = 0;
  const result = await deliverPurchaseWelcome({
    purchase: purchase(),
    config,
    claimDelivery: async () => true,
    sendEmail: async () => ({ id: "email_123" }),
    markAccepted: async () => false,
    markFailed: async () => { failures += 1; },
  });
  assert.deepEqual(result, { ok: false, error: "delivery_failed" });
  assert.equal(failures, 0, "leave the claim stale so the idempotent send can be reclaimed");
});

test("does not send welcome email for a non-succeeded or malformed purchase", async () => {
  let claims = 0;
  for (const invalidPurchase of [
    { ...purchase(), status: "processing" },
    { ...purchase(), customerEmail: "invalid" },
    { ...purchase(), accessDays: 0 },
  ]) {
    const result = await deliverPurchaseWelcome({
      purchase: invalidPurchase,
      config,
      claimDelivery: async () => { claims += 1; return true; },
      sendEmail: async () => ({ id: "email_123" }),
      markAccepted: async () => true,
      markFailed: async () => {},
    });
    assert.deepEqual(result, { ok: false, error: "invalid_purchase" });
  }
  assert.equal(claims, 0);
});
