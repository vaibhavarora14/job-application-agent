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

const binding = {
  version: 1,
  attentionId: "attention-1",
  jobUrl: "https://jobs.ashbyhq.com/livekit/application",
  browserProfilePath: "/tmp/jaa-chrome",
  display: ":99",
  vncPort: 5900,
  createdAt: "2026-09-16T00:00:00.000Z",
};

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
    pageUrl: "https://jobs.ashbyhq.com/x/application",
    pageText: "Thank you for applying",
  }).confirmed, true);
});

test("decideResumeSubmit: ready to submit when clear", () => {
  const decision = decideResumeSubmit({
    binding,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit/application",
      submitEnabled: true,
      leaseHeld: true,
    },
  });
  assert.equal(decision.action, "ready_to_submit");
  assert.equal(decision.exitCode, RESUME_EXIT.READY_TO_SUBMIT);
  assert.match(decision.message, /submit if possible/i);
});

test("decideResumeSubmit: still blocked on captcha", () => {
  const decision = decideResumeSubmit({
    binding,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit/application",
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
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit",
      leaseHeld: true,
    },
  });
  assert.equal(drift.action, "tab_drift");
  assert.equal(drift.exitCode, RESUME_EXIT.TAB_OR_BINDING);

  const confirmed = decideResumeSubmit({
    binding,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit/application",
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
    snapshot: { pageUrl: "https://jobs.ashbyhq.com/livekit/application" },
  }).exitCode, RESUME_EXIT.TAB_OR_BINDING);

  const ambiguous = decideResumeSubmit({
    binding,
    snapshot: {
      pageUrl: "https://jobs.ashbyhq.com/livekit/application",
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
});
