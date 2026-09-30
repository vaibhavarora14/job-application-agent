import assert from "node:assert/strict";
import test from "node:test";

import { handleFoundingPaymentWebhook } from "../lib/founding-payment-ops.mjs";
import {
  DEFAULT_FOUNDING_SUPPORT_ALERT_EMAIL,
  buildFoundingSupportAlert,
  sendFoundingSupportAlert,
} from "../lib/founding-support-alert.mjs";

const purchaseId = "11111111-1111-4111-8111-111111111111";

test("buildFoundingSupportAlert includes purchaseId, buyer email, and payment id", () => {
  const alert = buildFoundingSupportAlert({
    purchaseId,
    customerEmail: "Buyer@Example.COM",
    paymentId: "pay_abc",
    amount: 4900,
    currency: "usd",
    eventType: "payment.succeeded",
  });
  assert.match(alert.subject, /Paid/);
  assert.match(alert.subject, /buyer@example.com/);
  assert.match(alert.text, new RegExp(`purchaseId: ${purchaseId}`));
  assert.match(alert.text, /buyerEmail: buyer@example.com/);
  assert.match(alert.text, /paymentId: pay_abc/);
  assert.match(alert.text, /amount: 4900 USD/);
  assert.match(alert.text, /activatePurchase stays ops-only/);
  assert.doesNotMatch(alert.text, /refund/i);
  assert.equal(alert.customerEmail, "buyer@example.com");
});

test("sendFoundingSupportAlert logs and emails Support when Resend is configured", async () => {
  const logs = [];
  /** @type {RequestInit | undefined} */
  let seen;
  const result = await sendFoundingSupportAlert({
    purchaseId,
    customerEmail: "buyer@example.com",
    paymentId: "pay_1",
  }, {
    apiKey: "re_test",
    to: "ops@example.com",
    from: "JobAppAgent Ops <ops@example.com>",
    logger: {
      info: (message) => logs.push(message),
      error: (message) => logs.push(message),
      warn: (message) => logs.push(message),
    },
    fetchImpl: async (_url, init) => {
      seen = init;
      return Response.json({ id: "email_1" }, { status: 200 });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.channel, "resend");
  assert.equal(result.id, "email_1");
  assert.match(logs.join("\n"), /founding_payment_support_alert/);
  assert.match(logs.join("\n"), new RegExp(purchaseId));
  const body = JSON.parse(String(seen?.body));
  assert.deepEqual(body.to, ["ops@example.com"]);
  assert.match(body.subject, /buyer@example.com/);
  assert.match(body.text, /purchaseId:/);
});

test("sendFoundingSupportAlert falls back to structured log when Resend is unset", async () => {
  const logs = [];
  const result = await sendFoundingSupportAlert({
    purchaseId,
    customerEmail: "buyer@example.com",
    paymentId: "pay_2",
  }, {
    apiKey: "",
    logger: {
      info: (message) => logs.push(message),
      warn: (message) => logs.push(message),
      error: (message) => logs.push(message),
    },
    fetchImpl: async () => {
      throw new Error("should not call Resend");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.channel, "log_only");
  assert.match(logs.join("\n"), /structured log only|founding_payment_support_alert/);
  assert.equal(DEFAULT_FOUNDING_SUPPORT_ALERT_EMAIL, "founders@jobappagent.com");
});

test("handleFoundingPaymentWebhook persists succeeded payment and alerts Support without activating", async () => {
  /** @type {Array<[string, object]>} */
  const persisted = [];
  /** @type {object[]} */
  const alerts = [];
  let activateCalls = 0;

  const payment = {
    eventType: "payment.succeeded",
    purchaseId,
    paymentId: "pay_live_1",
    productId: "pdt_founding",
    customerId: "cus_1",
    customerEmail: "buyer@example.com",
    status: "succeeded",
    amount: 4900,
    currency: "USD",
  };

  const handled = await handleFoundingPaymentWebhook({
    eventId: "wh_evt_1",
    payment,
    persist: async (eventId, row) => {
      persisted.push([eventId, row]);
      // Simulate D1 paid/succeeded write side-effect.
      assert.equal(row.status, "succeeded");
      assert.equal(row.purchaseId, purchaseId);
      return { isNewEvent: true };
    },
    alertSupport: async (input) => {
      alerts.push(input);
      return { ok: true, channel: "resend", id: "email_ops" };
    },
  });

  assert.equal(handled.purchaseUpdated, true);
  assert.equal(handled.activated, false);
  assert.equal(handled.isNewEvent, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0][0], "wh_evt_1");
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0], {
    purchaseId,
    customerEmail: "buyer@example.com",
    paymentId: "pay_live_1",
    amount: 4900,
    currency: "USD",
    eventType: "payment.succeeded",
  });
  assert.equal(activateCalls, 0);
  assert.equal(handled.alert?.ok, true);
});

test("handleFoundingPaymentWebhook skips Support alert on webhook replay", async () => {
  const alerts = [];
  const handled = await handleFoundingPaymentWebhook({
    eventId: "wh_evt_replay",
    payment: {
      eventType: "payment.succeeded",
      purchaseId,
      paymentId: "pay_live_2",
      status: "succeeded",
      customerEmail: "buyer@example.com",
      amount: 4900,
      currency: "USD",
    },
    persist: async () => ({ isNewEvent: false }),
    alertSupport: async (input) => {
      alerts.push(input);
      return { ok: true };
    },
  });
  assert.equal(handled.activated, false);
  assert.equal(handled.isNewEvent, false);
  assert.equal(alerts.length, 0);
  assert.equal(handled.alert, null);
});

test("handleFoundingPaymentWebhook refuses an activatePurchase dependency", async () => {
  await assert.rejects(
    () => handleFoundingPaymentWebhook({
      eventId: "wh_evt_bad",
      payment: {
        eventType: "payment.succeeded",
        purchaseId,
        paymentId: "pay_x",
        status: "succeeded",
      },
      persist: async () => ({ isNewEvent: true }),
      alertSupport: async () => ({ ok: true }),
      activatePurchase: async () => ({ activated: true }),
    }),
    /activatePurchase must not be wired/,
  );
});

test("non-succeeded payment webhooks persist without Support alert or activation", async () => {
  const alerts = [];
  const handled = await handleFoundingPaymentWebhook({
    eventId: "wh_evt_fail",
    payment: {
      eventType: "payment.failed",
      purchaseId,
      paymentId: "pay_fail",
      status: "failed",
      customerEmail: "buyer@example.com",
    },
    persist: async () => ({ isNewEvent: true }),
    alertSupport: async (input) => {
      alerts.push(input);
      return { ok: true };
    },
  });
  assert.equal(handled.activated, false);
  assert.equal(alerts.length, 0);
});
