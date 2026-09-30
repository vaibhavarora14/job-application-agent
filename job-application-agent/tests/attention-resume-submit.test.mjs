import assert from "node:assert/strict";
import test from "node:test";

import {
  ASHBY_ADAPTER,
  buildSubmitProbePlan,
  detectAbsoluteBlockers,
  detectConfirmation,
  resolveAtsAdapter,
} from "../scripts/ats/submit-adapters.mjs";
import {
  RESUME_EXIT,
  decideResumeSubmit,
  resumeSubmitChecklist,
} from "../scripts/attention-resume-submit.mjs";

const FIXTURE_APPLY = "https://jobappagent.com/fixtures/ashby/";
const FIXTURE_CONFIRM = "https://jobappagent.com/fixtures/ashby/confirmation.html";

const binding = {
  version: 1,
  attentionId: "attention-1",
  jobUrl: FIXTURE_APPLY,
  browserProfilePath: "/tmp/jaa-chrome",
  display: ":99",
  vncPort: 5900,
  createdAt: "2026-09-16T00:00:00.000Z",
};

const gateOn = { APPLY_URL_GATE: "1", LIVE_APPLY: "0" };

test("resolveAtsAdapter picks Ashby for ashbyhq hosts", () => {
  assert.equal(resolveAtsAdapter("https://jobs.ashbyhq.com/x/application").id, "ashby");
  assert.equal(resolveAtsAdapter("https://boards.greenhouse.io/x").id, "generic");
  assert.ok(ASHBY_ADAPTER.submitSelectors.length >= 2);
});

test("detectAbsoluteBlockers and confirmation helpers", () => {
  assert.equal(detectAbsoluteBlockers({ pageText: "Please complete the reCAPTCHA" }).blocked, true);
  assert.equal(detectConfirmation({
    pageUrl: "https://jobs.ashbyhq.com/x/application-submitted",
  }).confirmed, true);
  assert.equal(detectConfirmation({
    pageUrl: FIXTURE_CONFIRM,
    pageText: "Thank you for applying (fixture)",
  }).confirmed, true);
});

test("decideResumeSubmit: ready to submit when clear on fixture URL", () => {
  const decision = decideResumeSubmit({
    binding,
    env: gateOn,
    snapshot: {
      pageUrl: FIXTURE_APPLY,
      submitEnabled: true,
      leaseHeld: true,
    },
  });
  assert.equal(decision.action, "ready_to_submit");
  assert.equal(decision.exitCode, RESUME_EXIT.READY_TO_SUBMIT);
  assert.match(decision.message, /submit if possible/i);
});

test("decideResumeSubmit: refuses real employer URL when gate on", () => {
  const decision = decideResumeSubmit({
    binding: { ...binding, jobUrl: "https://jobs.ashbyhq.com/confluent/application" },
    env: gateOn,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/confluent/application",
      submitEnabled: true,
      leaseHeld: true,
    },
  });
  assert.equal(decision.action, "url_not_allowlisted");
  assert.equal(decision.exitCode, RESUME_EXIT.ERROR);
  assert.match(decision.message, /allowlist|LIVE_APPLY/i);
});

test("decideResumeSubmit: LIVE_APPLY=1 allows real employer URL", () => {
  const realBinding = { ...binding, jobUrl: "https://jobs.ashbyhq.com/confluent/application" };
  const decision = decideResumeSubmit({
    binding: realBinding,
    env: { APPLY_URL_GATE: "1", LIVE_APPLY: "1" },
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/confluent/application",
      submitEnabled: true,
      leaseHeld: true,
    },
  });
  assert.equal(decision.action, "ready_to_submit");
  assert.equal(decision.exitCode, RESUME_EXIT.READY_TO_SUBMIT);
});

test("decideResumeSubmit: still blocked on captcha", () => {
  const decision = decideResumeSubmit({
    binding,
    env: gateOn,
    snapshot: {
      pageUrl: FIXTURE_APPLY,
      pageText: "hCaptcha challenge",
      leaseHeld: true,
    },
  });
  assert.equal(decision.action, "still_blocked");
  assert.equal(decision.exitCode, RESUME_EXIT.STILL_BLOCKED);
});

test("decideResumeSubmit: tab drift and confirmation", () => {
  const drift = decideResumeSubmit({
    binding,
    env: gateOn,
    snapshot: {
      pageUrl: "https://jobappagent.com/fixtures/",
      leaseHeld: true,
    },
  });
  assert.equal(drift.action, "tab_drift");
  assert.equal(drift.exitCode, RESUME_EXIT.TAB_OR_BINDING);

  const confirmed = decideResumeSubmit({
    binding: { ...binding, jobUrl: FIXTURE_CONFIRM },
    env: gateOn,
    snapshot: {
      pageUrl: FIXTURE_CONFIRM,
      matchedConfirmationSelectors: ["text=/thank you/i"],
      leaseHeld: true,
    },
  });
  assert.equal(confirmed.action, "submitted_confirmed");
  assert.equal(confirmed.exitCode, RESUME_EXIT.SUBMITTED);
});

test("decideResumeSubmit: missing binding and ambiguous submit", () => {
  assert.equal(decideResumeSubmit({
    binding: null,
    env: gateOn,
    snapshot: { pageUrl: FIXTURE_APPLY },
  }).exitCode, RESUME_EXIT.TAB_OR_BINDING);

  const ambiguous = decideResumeSubmit({
    binding,
    env: gateOn,
    snapshot: {
      pageUrl: FIXTURE_APPLY,
      submitAlreadyClicked: true,
      leaseHeld: true,
    },
  });
  assert.equal(ambiguous.action, "submit_ambiguous");
  assert.equal(ambiguous.exitCode, RESUME_EXIT.AWAITING_CONFIRM);
});

test("buildSubmitProbePlan and checklist are actionable", () => {
  const plan = buildSubmitProbePlan("https://jobs.ashbyhq.com/x/application");
  assert.equal(plan.adapterId, "ashby");
  assert.ok(plan.submitSelectors.includes('button[type="submit"]'));
  const lines = resumeSubmitChecklist();
  assert.ok(lines.some((l) => /DISPLAY=:99/i.test(l)));
  assert.ok(lines.some((l) => /intent-confirm|ledger add/i.test(l)));
  assert.ok(lines.some((l) => /LIVE_APPLY/i.test(l)));
});
