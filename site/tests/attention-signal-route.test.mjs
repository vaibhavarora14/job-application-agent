import assert from "node:assert/strict";
import test from "node:test";

import {
  canContinueApplying,
  employerAnswersAllowResume,
} from "../lib/attention-buyer-flow.mjs";
import { signAttentionMagicLink, verifyAttentionMagicLink } from "../lib/attention-magic-link.mjs";
import {
  ATTENTION_SIGNAL_ACTIONS,
  buildAttentionSignalRecord,
  validateAttentionSignalRequest,
} from "../lib/attention-signals.mjs";

const secret = "test-only-attention-route-secret";

/**
 * Mirrors POST /api/attention/:id/signal resume/skip gating without bundling
 * the TypeScript route (esbuild is site-only; root Validate has no site deps).
 */
function evaluateSignal({ token, attentionId, action, answers }) {
  const validated = validateAttentionSignalRequest({ token, action, answers });
  if (!validated.ok) return { status: validated.status, error: validated.error };
  return evaluateValidatedSignal(validated.data, attentionId);
}

async function evaluateValidatedSignal(data, attentionId) {
  const verified = await verifyAttentionMagicLink(data.token, secret, { attentionId });
  if (!verified.ok) return { status: 401, error: verified.error };
  const payload = verified.payload;
  if (!payload) return { status: 401, error: "token_invalid" };

  if (data.signal === ATTENTION_SIGNAL_ACTIONS.resume_requested
    && !employerAnswersAllowResume(payload.questions ?? [], data.answers)) {
    return { status: 400, error: "employer_answers_required" };
  }

  const record = buildAttentionSignalRecord(attentionId, data.signal, { answers: data.answers });
  return { status: 200, signal: record.signal, record };
}

test("signal route enforces token and required answers before storing coordination", async () => {
  const signed = await signAttentionMagicLink({
    attentionId: "test",
    company: "Acme",
    role: "Engineer",
    questions: [{ id: "why", prompt: "Why this company?", required: true }],
  }, secret);

  assert.equal((await evaluateSignal({
    token: "design-fixture", attentionId: "test", action: "resume", answers: [],
  })).status, 401);

  for (const answers of [[], [{ questionId: "why", text: " \n\t " }], [{ questionId: "unknown", text: "Answer" }]]) {
    assert.equal((await evaluateSignal({
      token: signed.token, attentionId: "test", action: "resume", answers,
    })).status, 400);
  }

  const response = await evaluateSignal({
    token: signed.token,
    attentionId: "test",
    action: "resume",
    answers: [{ questionId: "why", text: "Relevant experience" }],
  });
  assert.equal(response.status, 200);
  assert.equal(response.signal, "resume_requested");
  assert.equal(response.record.payload.answers[0].text, "Relevant experience");
});

test("technical-only tokens cannot signal buyer resume; skip remains available", async () => {
  const signed = await signAttentionMagicLink({
    attentionId: "test",
    blocker: "captcha",
    requiredActions: ["complete-captcha"],
  }, secret);

  assert.equal((await evaluateSignal({
    token: signed.token, attentionId: "test", action: "resume", answers: [],
  })).status, 400);

  const response = await evaluateSignal({
    token: signed.token, attentionId: "test", action: "skip", answers: [],
  });
  assert.equal(response.status, 200);
  assert.equal(response.signal, "skipped");
});

test("employerAnswersAllowResume matches Continue applying + unknown-id rejection", () => {
  const questions = [{ id: "why", prompt: "Why?", required: true }];
  assert.equal(employerAnswersAllowResume(questions, []), false);
  assert.equal(employerAnswersAllowResume(questions, [{ questionId: "why", text: " \n " }]), false);
  assert.equal(employerAnswersAllowResume(questions, [{ questionId: "unknown", text: "Answer" }]), false);
  assert.equal(employerAnswersAllowResume(questions, [{ questionId: "why", text: "Relevant experience" }]), true);
  assert.equal(employerAnswersAllowResume([], []), false);
  assert.equal(canContinueApplying([], {}), false);
});
