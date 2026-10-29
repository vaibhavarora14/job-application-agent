import assert from "node:assert/strict";
import test from "node:test";
import { redactLogDetail } from "../lib/log-redaction.mjs";
import { sendFoundingSupportAlert, logFoundingSupportAlert, buildFoundingSupportAlert } from "../lib/founding-support-alert.mjs";
import { sendAttentionEmail } from "../lib/attention-mail.mjs";

const buyer = "Buyer.Person+tag@example.com";

test("redactLogDetail strips emails and bounds length", () => {
  assert.equal(redactLogDetail(`bad to: ${buyer}, cc a@b.io`), "bad to: [email], cc [email]");
  assert.equal(redactLogDetail("x".repeat(500)).length, 200);
  assert.equal(redactLogDetail(undefined), "");
});

test("founding support alert log line never contains the buyer email or subject", () => {
  const logs = [];
  const payload = logFoundingSupportAlert(buildFoundingSupportAlert({ purchaseId: "pur_123", customerEmail: buyer, paymentId: "pay_1" }), { logger: { info: (m) => logs.push(m) } });
  const line = logs.join("\n");
  assert.match(line, /pur_123/);
  assert.doesNotMatch(line, /@/);
  assert.equal(payload.buyerEmailPresent, true);
  assert.equal("buyerEmail" in payload, false);
  assert.equal("subject" in payload, false);
});

test("Resend rejection details are redacted in every founding log line", async () => {
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  await sendFoundingSupportAlert({ purchaseId: "pur_9", customerEmail: buyer }, {
    apiKey: "re_test", to: "ops@example.org", logger,
    fetchImpl: async () => new Response(`Invalid recipient ${buyer}`, { status: 422 }),
  });
  assert.ok(logs.length >= 2);
  assert.ok(logs.length >= 1);
  assert.doesNotMatch(logs.join("\n"), /@/);
});

test("attention mail Resend rejection log is redacted", async () => {
  const logs = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  await sendAttentionEmail({ to: buyer, company: "Acme", role: "Engineer", blocker: "judgment", requiredActions: ["provide-judgment"], attentionId: "att_1", magicLinkUrl: "https://jobappagent.com/attention/att_1#t", questions: [{ id: "why", prompt: "Why this company?", required: true }] }, {
    apiKey: "re_test", logger,
    fetchImpl: async () => new Response(`Invalid to ${buyer}`, { status: 422 }),
  });
  assert.ok(logs.length >= 1);
  assert.doesNotMatch(logs.join("\n"), /@/);
});
