import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAiAssistanceDiscouraged,
  fingerprintPrompt,
  hasJudgmentActions,
  needsLiveBrowser,
  normalizeAttentionAnswers,
  normalizeAttentionQuestions,
  suggestPriorAnswers,
} from "../lib/attention-questions.mjs";
import {
  buildHeuristicDraft,
  draftAttentionAnswer,
  humanizeDraftText,
  resolveDraftConfig,
} from "../lib/attention-draft.mjs";
import {
  ATTENTION_SIGNAL_ACTIONS,
  formatRunnerSignalPoll,
  validateAttentionSignalRequest,
} from "../lib/attention-signals.mjs";
import { signAttentionMagicLink, verifyAttentionMagicLink } from "../lib/attention-magic-link.mjs";
import { validateAttentionNotifyRequest } from "../lib/attention-notify.mjs";

const SECRET = "test-attention-magic-link-secret-32b";

test("detects LiveKit-class AI assistance discouragement", () => {
  assert.equal(detectAiAssistanceDiscouraged("Please don't use AI assistance when answering."), true);
  assert.equal(detectAiAssistanceDiscouraged("Write in your own words."), true);
  assert.equal(detectAiAssistanceDiscouraged("We use AI in our product."), false);
});

test("normalizes questions and answers", () => {
  const questions = normalizeAttentionQuestions([
    { prompt: "Why LiveKit?", kind: "why-us" },
    { prompt: "Why LiveKit?", kind: "why-us" },
    { id: "q2", prompt: "Proud project?", required: false },
  ]);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].kind, "why-us");
  assert.equal(questions[1].required, false);

  const answers = normalizeAttentionAnswers([
    { questionId: "q2", text: "  shipped a thing  ", source: "draft_approved" },
    { questionId: "q2", text: "dup" },
    { questionId: "", text: "nope" },
  ]);
  assert.deepEqual(answers, [{ questionId: "q2", text: "shipped a thing", source: "draft_approved" }]);
});

test("suggestPriorAnswers ranks by overlap", () => {
  const suggestions = suggestPriorAnswers("Why do you want to work here?", [
    { fingerprint: "a", prompt: "Why this company?", text: "I care about the product." },
    { fingerprint: "b", prompt: "Salary expectations", text: "Market rate." },
  ]);
  assert.equal(suggestions[0].fingerprint, "a");
  assert.ok(suggestions[0].score >= 0.15);
});

test("needsLiveBrowser vs judgment helpers", () => {
  assert.equal(needsLiveBrowser(["provide-judgment"]), false);
  assert.equal(needsLiveBrowser(["provide-judgment", "complete-captcha"]), true);
  assert.equal(hasJudgmentActions(["provide-judgment"]), true);
});

test("draft endpoint helpers fail closed without key", async () => {
  assert.equal(resolveDraftConfig({ apiKey: "" }).configured, false);
  const result = await draftAttentionAnswer({
    prompt: "Why us?",
    company: "LiveKit",
    role: "Engineer",
  }, { apiKey: "" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "draft_unconfigured");
  assert.match(result.heuristic, /LiveKit/);
  assert.equal(humanizeDraftText("hello — world").includes("—"), false);
  assert.match(buildHeuristicDraft({ prompt: "proud project", company: "Acme" }), /proud/i);
});

test("magic link carries questions and aiAssistanceDiscouraged", async () => {
  const signed = await signAttentionMagicLink({
    attentionId: "attention-q",
    company: "LiveKit",
    role: "Engineer",
    blocker: "judgment",
    requiredActions: ["provide-judgment"],
    questions: [{ id: "why", prompt: "Why LiveKit?", kind: "why-us" }],
    postingText: "Do not use AI assistance.",
  }, SECRET, { now: 1_700_000_000 });
  assert.equal(signed.ok, true);
  const verified = await verifyAttentionMagicLink(signed.token, SECRET, {
    attentionId: "attention-q",
    now: 1_700_000_000,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.aiAssistanceDiscouraged, true);
  assert.equal(verified.payload.questions[0].id, "why");
});

test("notify + signal validate answers payload", () => {
  const notify = validateAttentionNotifyRequest({
    attentionId: "attention-1",
    email: "a@b.co",
    company: "Acme",
    role: "Eng",
    blocker: "judgment",
    requiredActions: ["provide-judgment"],
    questions: [{ prompt: "Why us?" }],
    postingText: "No AI assistance please",
  });
  assert.equal(notify.ok, true);
  assert.equal(notify.data.aiAssistanceDiscouraged, true);
  assert.equal(notify.data.questions.length, 1);

  const signal = validateAttentionSignalRequest({
    token: "t",
    action: "resume",
    answers: [{ questionId: "why", text: "Because.", source: "typed" }],
  });
  assert.equal(signal.ok, true);
  assert.equal(signal.data.signal, ATTENTION_SIGNAL_ACTIONS.resume_requested);
  assert.equal(signal.data.answers[0].questionId, "why");

  const poll = formatRunnerSignalPoll({
    attentionId: "attention-1",
    signal: "resume_requested",
    payload: { answers: [{ questionId: "why", text: "Because.", source: "bank" }] },
    updatedAt: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(poll.resumeRequested, true);
  assert.equal(poll.answers[0].source, "bank");
  assert.equal(fingerprintPrompt("Why us?").startsWith("q-"), true);
});
