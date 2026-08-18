import test from "node:test";
import assert from "node:assert/strict";
import { validateFoundingRegistration, validatePaidIntent } from "../lib/founding-validation.mjs";

test("normalizes a valid founding registration", () => {
  const result = validateFoundingRegistration({
    email: "  Founder@Example.com ",
    targetRole: "  Product Engineer ",
    targetLocation: " Remote — India ",
    source: "x-launch",
    company: "",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    email: "founder@example.com",
    targetRole: "Product Engineer",
    targetLocation: "Remote — India",
    source: "x-launch",
  });
});

test("rejects invalid email and missing role with human-readable field errors", () => {
  const result = validateFoundingRegistration({ email: "not-an-email", targetRole: "" });
  assert.equal(result.ok, false);
  assert.equal(result.errors.email, "Enter a valid email address.");
  assert.equal(result.errors.targetRole, "Tell us the role you want the agent to search for.");
});

test("quietly identifies honeypot submissions", () => {
  const result = validateFoundingRegistration({
    email: "person@example.com",
    targetRole: "Designer",
    company: "bot-filled",
  });
  assert.equal(result.ok, true);
  assert.equal(result.bot, true);
});

test("accepts only supported paid-intent choices", () => {
  assert.deepEqual(validatePaidIntent("ready_to_pay"), { ok: true, intent: "ready_to_pay" });
  assert.deepEqual(validatePaidIntent("needs_trial"), { ok: true, intent: "needs_trial" });
  assert.deepEqual(validatePaidIntent("maybe"), { ok: false, error: "Choose one of the available options." });
});
