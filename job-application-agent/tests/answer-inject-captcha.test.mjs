import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAnswerInjectPlan,
  labelSimilarity,
  mapAnswersToFields,
  shouldInjectAnswersBeforeSubmit,
} from "../scripts/ats/answer-inject.mjs";
import {
  detectAiAssistanceDiscouraged,
  extractNarrativeQuestionsFromText,
  normalizeAttentionQuestions,
} from "../scripts/attention-questions.mjs";
import {
  checkCaptchaSpendCap,
  detectChallenge,
  resolveCaptchaVendorConfig,
  tryCaptchaVendorAssist,
} from "../scripts/captcha-vendor.mjs";
import {
  RESUME_EXIT,
  decideResumeSubmit,
} from "../scripts/attention-resume-submit.mjs";

const binding = {
  version: 1,
  attentionId: "attention-1",
  jobUrl: "https://jobs.ashbyhq.com/livekit/application",
  browserProfilePath: "/tmp/jaa-chrome",
  display: ":99",
  vncPort: 5900,
  createdAt: "2026-09-16T00:00:00.000Z",
  questions: [
    { id: "why", prompt: "Why do you want to work at LiveKit?", kind: "why-us", required: true },
  ],
};

test("mapAnswersToFields matches by id and label", () => {
  const mapped = mapAnswersToFields(
    [
      { questionId: "why", text: "Because realtime infra.", source: "typed", prompt: "Why LiveKit?" },
      { questionId: "proud", text: "Shipped agents.", source: "bank", prompt: "Proud project?" },
    ],
    [
      { id: "why", label: "Why LiveKit?", selector: "textarea#why" },
      { id: "other", label: "Project you are proud of", selector: "textarea#proud" },
    ],
  );
  assert.equal(mapped.mappings.length, 2);
  assert.equal(mapped.mappings[0].matchedBy, "question_id");
  assert.ok(mapped.mappings[1].score >= 0.25);
  assert.ok(labelSimilarity("why this role", "why this company") > 0.2);
});

test("buildAnswerInjectPlan prefers ashby hint", () => {
  const plan = buildAnswerInjectPlan({
    pageUrl: "https://jobs.ashbyhq.com/x/application",
    answers: [{ questionId: "why", text: "Hello", source: "typed", prompt: "Why us?" }],
  });
  assert.equal(plan.adapterHint, "ashby");
  assert.equal(plan.fills.length, 1);
  assert.equal(plan.fills[0].action, "fill_textarea");
  assert.equal(shouldInjectAnswersBeforeSubmit({ answers: plan.fills }).inject, true);
});

test("pause packaging extracts questions and AI policy", () => {
  const text = "Why do you want to work at LiveKit? Do not use AI assistance.";
  assert.equal(detectAiAssistanceDiscouraged(text), true);
  const extracted = extractNarrativeQuestionsFromText(text);
  assert.ok(extracted.length >= 1);
  assert.equal(normalizeAttentionQuestions(extracted)[0].kind, "why-us");
});

test("decideResumeSubmit injects answers before submit", () => {
  const decision = decideResumeSubmit({
    binding,
    answers: [{ questionId: "why", text: "I want to build realtime systems.", source: "typed" }],
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit/application",
      submitEnabled: true,
      leaseHeld: true,
    },
  });
  assert.equal(decision.action, "inject_answers");
  assert.equal(decision.exitCode, RESUME_EXIT.INJECT_ANSWERS);
  assert.equal(decision.injectPlan.fills[0].text.includes("realtime"), true);

  const after = decideResumeSubmit({
    binding,
    answers: [{ questionId: "why", text: "I want to build realtime systems.", source: "typed" }],
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit/application",
      submitEnabled: true,
      leaseHeld: true,
      answersInjected: true,
    },
  });
  assert.equal(after.action, "ready_to_submit");
});

test("captcha vendor off → no network and fail closed", async () => {
  let network = 0;
  const fetchImpl = async () => {
    network += 1;
    return new Response("{}");
  };

  const off = await tryCaptchaVendorAssist({
    env: { CAPTCHA_VENDOR: "off" },
    fetchImpl,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/x/application",
      pageHtml: '<div class="g-recaptcha" data-sitekey="abc"></div>',
    },
  });
  assert.equal(off.reason, "vendor_off");
  assert.equal(off.fallback, "complete-captcha");
  assert.equal(network, 0);

  const missingKey = await tryCaptchaVendorAssist({
    env: { CAPTCHA_VENDOR: "capsolver", CAPTCHA_BUYER_OPT_IN: "on" },
    fetchImpl,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/x/application",
      pageHtml: '<div class="g-recaptcha" data-sitekey="abc"></div>',
    },
  });
  assert.equal(missingKey.reason, "api_key_missing");
  assert.equal(network, 0);

  const unsupported = await tryCaptchaVendorAssist({
    env: {
      CAPTCHA_VENDOR: "capsolver",
      CAPTCHA_VENDOR_API_KEY: "test-key",
      CAPTCHA_BUYER_OPT_IN: "on",
    },
    fetchImpl,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/x/application",
      pageHtml: "<div>hCaptcha challenge</div>",
      challengeType: "hcaptcha",
    },
  });
  assert.equal(unsupported.reason, "unsupported_type");
  assert.equal(network, 0);
  assert.equal(detectChallenge({ pageHtml: "cf-turnstile" }).type, "turnstile");
  assert.equal(resolveCaptchaVendorConfig({}).vendor, "off");
  assert.equal(checkCaptchaSpendCap({ spendMonthUsd: 5, spendCapUsd: 5, additionalUsd: 0.01 }).ok, false);
});

test("still_blocked captcha surfaces vendor_off assist note", () => {
  const decision = decideResumeSubmit({
    binding,
    captchaAssist: {
      reason: "vendor_off",
      fallback: "complete-captcha",
      networkCalled: false,
    },
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit/application",
      pageText: "Please complete the reCAPTCHA",
      leaseHeld: true,
      answersInjected: true,
    },
  });
  assert.equal(decision.action, "still_blocked");
  assert.equal(decision.captchaAssist.reason, "vendor_off");
});
