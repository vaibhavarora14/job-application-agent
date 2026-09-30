import assert from "node:assert/strict";
import test from "node:test";
import { buyerAttentionStep, canContinueApplying, chooseActionLabel, needsAdminAttention, BUYER_FLOW_COPY } from "../lib/attention-buyer-flow.mjs";

const questions = [{ id: "why", prompt: "Why this company?", required: true }, { id: "extra", prompt: "Anything else?", required: false }];

test("only packaged employer questions cause a buyer pause", () => {
  for (const blocker of ["captcha", "unsolvable", "live-required", "session-lost", "site-error", "judgment"]) {
    assert.equal(buyerAttentionStep({ blocker, requiredActions: ["provide-judgment"] }), "queue");
    assert.equal(needsAdminAttention({ blocker }), true);
  }
  assert.equal(buyerAttentionStep({ questions }), "judgment");
  assert.equal(needsAdminAttention({ questions, blocker: "judgment" }), false);
  for (const blocker of ["captcha", "unsolvable", "live-required", "recovering", "legal-attestation", "unknown-site-gate"]) {
    assert.equal(needsAdminAttention({ questions, blocker }), true);
  }
  assert.equal(needsAdminAttention({ questions, requiredActions: ["complete-captcha"] }), true);
});

test("Continue applying requires every required answer and at least one real answer", () => {
  for (const text of ["", " ", "\n\t"]) assert.equal(canContinueApplying(questions, { why: { text } }), false);
  assert.equal(canContinueApplying(questions, { why: { text: "My answer" } }), true);
  assert.equal(canContinueApplying(questions, { extra: { text: "Other answer" } }), false);
  assert.equal(canContinueApplying([], {}), false);
  assert.equal(canContinueApplying([{ id: "extra", required: false }], {}), false);
});

test("locked CTAs and calm buyer copy", () => {
  assert.equal(BUYER_FLOW_COPY.preflight.primary, "Start applying");
  assert.equal(BUYER_FLOW_COPY.judgment.primary, "Continue applying");
  assert.equal(BUYER_FLOW_COPY.done.primary, "Back to search");
  assert.equal(chooseActionLabel(0), "Select at least 1 job");
  assert.equal(chooseActionLabel(1), "Apply to 1 job");
  assert.equal(chooseActionLabel(3), "Apply to 3 jobs");
  assert.doesNotMatch(JSON.stringify(BUYER_FLOW_COPY), /captcha|open live|try again|resume application|almost there|human-proof|session-lost|recovering/i);
});
