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
  CAPTCHA_FRICTION,
  checkCaptchaSpendCap,
  detectChallenge,
  injectCaptchaToken,
  resolveCaptchaVendorConfig,
  tryCaptchaVendorAssist,
} from "../scripts/captcha-vendor.mjs";
import {
  RESUME_EXIT,
  decideResumeSubmit,
} from "../scripts/attention-resume-submit.mjs";

const FAKE_SITEKEY = "6LeTestSitekeyAAAAAAAAAAAAAFakeKeyXX";
const FAKE_TOKEN = "03AGdBq-FAKE-CAPTCHA-TOKEN-DO-NOT-LOG";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Assert CAPTCHA tokens never leak into friction / human-facing message strings. */
function assertNoTokenInFrictionMessages(result, token = FAKE_TOKEN) {
  const frictionFields = [
    result.message,
    result.friction,
    result.reason,
    result.fallback,
    result.error,
  ].filter((v) => typeof v === "string");
  for (const field of frictionFields) {
    assert.equal(field.includes(token), false, `token leaked into friction field: ${field}`);
  }
}

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

test("CapSolver create+poll mocked success returns token and inject plan", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    if (String(url).includes("createTask")) {
      assert.equal(calls.at(-1).body.clientKey, "test-capsolver-key");
      assert.equal(calls.at(-1).body.task.type, "ReCaptchaV2TaskProxyLess");
      assert.equal(calls.at(-1).body.task.websiteKey, FAKE_SITEKEY);
      assert.ok(!("cookies" in calls.at(-1).body.task));
      assert.ok(!("apiKey" in calls.at(-1).body));
      return jsonResponse({ errorId: 0, taskId: "cap-task-1" });
    }
    if (String(url).includes("getTaskResult")) {
      if (calls.filter((c) => String(c.url).includes("getTaskResult")).length === 1) {
        return jsonResponse({ errorId: 0, status: "processing" });
      }
      return jsonResponse({
        errorId: 0,
        status: "ready",
        solution: { gRecaptchaResponse: FAKE_TOKEN },
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await tryCaptchaVendorAssist({
    env: {
      CAPTCHA_VENDOR: "capsolver",
      CAPTCHA_VENDOR_API_KEY: "test-capsolver-key",
      CAPTCHA_BUYER_OPT_IN: "on",
    },
    fetchImpl,
    sleepImpl: async () => {},
    pollInitialDelayMs: 0,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/confluent/application",
      pageHtml: `<div class="g-recaptcha" data-sitekey="${FAKE_SITEKEY}"></div>`,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.assisted, true);
  assert.equal(result.networkCalled, true);
  assert.equal(result.token, FAKE_TOKEN);
  assert.equal(result.type, "recaptcha_v2");
  assert.equal(result.friction, CAPTCHA_FRICTION.success);
  assert.ok(result.estimatedCostUsd > 0);
  assert.equal(result.inject.ok, true);
  assert.ok(result.inject.selectors.some((s) => s.includes("g-recaptcha-response")));
  assert.equal(result.inject.token, FAKE_TOKEN);
  assertNoTokenInFrictionMessages(result);
  assert.ok(calls.length >= 2);
});

test("CapSolver poll timeout fails closed without token in messages", async () => {
  let polls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("createTask")) {
      return jsonResponse({ errorId: 0, taskId: "cap-timeout" });
    }
    polls += 1;
    return jsonResponse({ errorId: 0, status: "processing" });
  };

  const result = await tryCaptchaVendorAssist({
    env: {
      CAPTCHA_VENDOR: "capsolver",
      CAPTCHA_VENDOR_API_KEY: "test-capsolver-key",
      CAPTCHA_BUYER_OPT_IN: "on",
    },
    fetchImpl,
    sleepImpl: async () => {},
    pollTimeoutMs: 5,
    pollInitialDelayMs: 0,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/x/application",
      pageHtml: `<div class="g-recaptcha" data-sitekey="${FAKE_SITEKEY}"></div>`,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.assisted, false);
  assert.equal(result.reason, "poll_timeout");
  assert.equal(result.fallback, "complete-captcha");
  assert.equal(result.networkCalled, true);
  assert.equal("token" in result && result.token, false);
  assertNoTokenInFrictionMessages(result);
  assert.ok(polls >= 1);
});

test("2Captcha create+poll mocked success for turnstile", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    if (String(url).includes("api.2captcha.com/createTask")) {
      assert.equal(body.clientKey, "test-2captcha-key");
      assert.equal(body.task.type, "TurnstileTaskProxyless");
      return jsonResponse({ errorId: 0, taskId: 998877 });
    }
    return jsonResponse({
      errorId: 0,
      status: "ready",
      solution: { token: FAKE_TOKEN },
      cost: "0.00145",
    });
  };

  const result = await tryCaptchaVendorAssist({
    env: {
      CAPTCHA_VENDOR: "2captcha",
      CAPTCHA_VENDOR_API_KEY: "test-2captcha-key",
      CAPTCHA_ASSIST: "on",
    },
    fetchImpl,
    sleepImpl: async () => {},
    pollInitialDelayMs: 0,
    snapshot: {
      pageUrl: "https://example.com/apply",
      pageHtml: `<div class="cf-turnstile" data-sitekey="${FAKE_SITEKEY}"></div>`,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.assisted, true);
  assert.equal(result.networkCalled, true);
  assert.equal(result.token, FAKE_TOKEN);
  assert.equal(result.type, "turnstile");
  assert.equal(result.inject.ok, true);
  assert.ok(result.inject.selectors.some((s) => s.includes("cf-turnstile-response")));
  assert.equal(result.estimatedCostUsd, 0.00145);
  assertNoTokenInFrictionMessages(result);
});

test("2Captcha Ashby reCAPTCHA v2 create→poll→inject (Confluent-shaped)", async () => {
  const pollBodies = [];
  let createCalls = 0;
  let pollCalls = 0;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (String(url) === "https://api.2captcha.com/createTask") {
      createCalls += 1;
      assert.equal(body.clientKey, "test-2captcha-key");
      assert.equal(body.task.type, "RecaptchaV2TaskProxyless");
      assert.equal(body.task.websiteURL, "https://jobs.ashbyhq.com/confluent/application");
      assert.equal(body.task.websiteKey, FAKE_SITEKEY);
      assert.equal(Object.keys(body.task).sort().join(","), "type,websiteKey,websiteURL");
      assert.ok(!("cookies" in body));
      assert.ok(!("session" in body));
      return jsonResponse({ errorId: 0, taskId: 72345678901 });
    }
    if (String(url) === "https://api.2captcha.com/getTaskResult") {
      pollCalls += 1;
      pollBodies.push(body);
      assert.equal(body.clientKey, "test-2captcha-key");
      assert.equal(body.taskId, 72345678901);
      assert.equal(typeof body.taskId, "number");
      if (pollCalls === 1) {
        return jsonResponse({ errorId: 0, status: "processing" });
      }
      return jsonResponse({
        errorId: 0,
        status: "ready",
        solution: {
          gRecaptchaResponse: FAKE_TOKEN,
          token: FAKE_TOKEN,
        },
        cost: "0.00299",
      });
    }
    throw new Error(`unexpected url ${url}`);
  };

  const result = await tryCaptchaVendorAssist({
    env: {
      CAPTCHA_VENDOR: "2captcha",
      CAPTCHA_VENDOR_API_KEY: "test-2captcha-key",
      CAPTCHA_BUYER_OPT_IN: "on",
    },
    fetchImpl,
    sleepImpl: async () => {},
    pollInitialDelayMs: 0,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/confluent/application",
      pageHtml: `<div class="g-recaptcha" data-sitekey="${FAKE_SITEKEY}"></div>`,
      challengeType: "recaptcha_v2",
    },
  });

  assert.equal(createCalls, 1);
  assert.equal(pollCalls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.assisted, true);
  assert.equal(result.networkCalled, true);
  assert.equal(result.token, FAKE_TOKEN);
  assert.equal(result.type, "recaptcha_v2");
  assert.equal(result.friction, CAPTCHA_FRICTION.success);
  assert.equal(result.estimatedCostUsd, 0.00299);
  assert.equal(result.inject.ok, true);
  assert.deepEqual(result.inject.fieldNames, ["g-recaptcha-response"]);
  assert.ok(result.inject.selectors.includes('textarea[name="g-recaptcha-response"]'));
  assert.equal(result.inject.guidance.invokeCallback, "grecaptcha_callback_if_present");
  assert.equal(result.inject.guidance.doNotPersistToken, true);
  assert.equal(result.message.includes(FAKE_TOKEN), false);
  assertNoTokenInFrictionMessages(result);
});

test("2Captcha create failure (zero balance) fails closed", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("createTask")) {
      return jsonResponse({
        errorId: 1,
        errorCode: "ERROR_ZERO_BALANCE",
        errorDescription: "Account has zero balance",
      });
    }
    throw new Error("should not poll after create failure");
  };

  const result = await tryCaptchaVendorAssist({
    env: {
      CAPTCHA_VENDOR: "2captcha",
      CAPTCHA_VENDOR_API_KEY: "test-2captcha-key",
      CAPTCHA_BUYER_OPT_IN: "on",
    },
    fetchImpl,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/confluent/application",
      pageHtml: `<div class="g-recaptcha" data-sitekey="${FAKE_SITEKEY}"></div>`,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.assisted, false);
  assert.equal(result.reason, "zero_balance");
  assert.equal(result.fallback, "complete-captcha");
  assert.equal(result.networkCalled, true);
  assert.ok(result.message.includes("balance"));
  assert.equal("token" in result && Boolean(result.token), false);
  assertNoTokenInFrictionMessages(result);
});

test("2Captcha poll unsolvable fails closed", async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes("createTask")) {
      return jsonResponse({ errorId: 0, taskId: 42 });
    }
    return jsonResponse({
      errorId: 12,
      errorCode: "ERROR_CAPTCHA_UNSOLVABLE",
    });
  };

  const result = await tryCaptchaVendorAssist({
    env: {
      CAPTCHA_VENDOR: "2captcha",
      CAPTCHA_VENDOR_API_KEY: "test-2captcha-key",
      CAPTCHA_BUYER_OPT_IN: "1",
    },
    fetchImpl,
    sleepImpl: async () => {},
    pollInitialDelayMs: 0,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/confluent/application",
      pageHtml: `<div class="g-recaptcha" data-sitekey="${FAKE_SITEKEY}"></div>`,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsolvable");
  assert.equal(result.fallback, "complete-captcha");
  assert.equal(result.networkCalled, true);
  assertNoTokenInFrictionMessages(result);
});

test("injectCaptchaToken returns structured selectors when enabled", () => {
  const config = resolveCaptchaVendorConfig({
    CAPTCHA_VENDOR: "capsolver",
    CAPTCHA_VENDOR_API_KEY: "k",
    CAPTCHA_BUYER_OPT_IN: "on",
  });
  const plan = injectCaptchaToken({ token: FAKE_TOKEN, type: "recaptcha_v2" }, config);
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.fieldNames, ["g-recaptcha-response"]);
  assert.equal(plan.token, FAKE_TOKEN);
  assert.equal(plan.guidance.doNotPersistToken, true);
  assert.equal(plan.guidance.invokeCallback, "grecaptcha_callback_if_present");

  const off = injectCaptchaToken({ token: FAKE_TOKEN }, resolveCaptchaVendorConfig({}));
  assert.equal(off.ok, false);
  assert.equal(off.error, "vendor_off");
});

test("spend cap still hard-stops before network", async () => {
  let network = 0;
  const result = await tryCaptchaVendorAssist({
    env: {
      CAPTCHA_VENDOR: "capsolver",
      CAPTCHA_VENDOR_API_KEY: "k",
      CAPTCHA_BUYER_OPT_IN: "on",
      CAPTCHA_SPEND_CAP_USD_MONTH: "5",
      CAPTCHA_SPEND_MONTH_USD: "5",
    },
    fetchImpl: async () => {
      network += 1;
      return jsonResponse({});
    },
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/x/application",
      pageHtml: `<div class="g-recaptcha" data-sitekey="${FAKE_SITEKEY}"></div>`,
    },
  });
  assert.equal(result.reason, "spend_cap_hit");
  assert.equal(result.friction, CAPTCHA_FRICTION.cap_hit);
  assert.equal(network, 0);
});

test("still_blocked surfaces inject guidance when vendor assist succeeded", () => {
  const decision = decideResumeSubmit({
    binding,
    captchaAssist: {
      ok: true,
      assisted: true,
      token: FAKE_TOKEN,
      inject: {
        ok: true,
        selectors: ['textarea[name="g-recaptcha-response"]'],
        token: FAKE_TOKEN,
      },
      networkCalled: true,
    },
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit/application",
      pageText: "Please complete the reCAPTCHA",
      leaseHeld: true,
      answersInjected: true,
    },
  });
  assert.equal(decision.action, "still_blocked");
  assert.ok(decision.next.some((line) => line.includes("inject via captchaAssist.inject")));
  assert.equal(JSON.stringify(decision.next).includes(FAKE_TOKEN), false);
});
