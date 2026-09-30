import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_LABELS,
  BLOCKER_LABELS,
  actionLabel,
  attentionPanelActionClasses,
  blockerLabel,
} from "../lib/attention-action-labels.mjs";

test("actionLabel maps known required-action codes", () => {
  assert.equal(actionLabel("complete-captcha"), "Complete CAPTCHA");
  assert.equal(actionLabel("review-legal"), "Review legal attestation");
  assert.equal(actionLabel("provide-judgment"), "Provide judgment answer");
});

test("actionLabel falls back to the raw action code", () => {
  assert.equal(actionLabel("open-live-session"), "open-live-session");
  assert.equal(actionLabel("unknown-custom-step"), "unknown-custom-step");
});

test("ACTION_LABELS covers the documented attention action set", () => {
  const expected = [
    "sign-in",
    "complete-mfa",
    "complete-captcha",
    "review-legal",
    "choose-demographic",
    "provide-government-id",
    "provide-authorization",
    "provide-compensation",
    "verify-claim",
    "provide-judgment",
    "record-video",
    "enable-upload",
    "retry-site",
  ];
  assert.deepEqual(Object.keys(ACTION_LABELS).sort(), [...expected].sort());
});

test("blockerLabel maps Quiet Trust buyer chips", () => {
  assert.equal(blockerLabel("legal-attestation"), "Legal attestation");
  assert.equal(blockerLabel("captcha"), "CAPTCHA");
  assert.equal(blockerLabel(""), "Paused");
  assert.equal(blockerLabel("custom-gate"), "custom gate");
  assert.ok(BLOCKER_LABELS.judgment);
});

test("attentionPanelActionClasses: live required + panel closed → Open live primary", () => {
  assert.deepEqual(attentionPanelActionClasses({ liveRequired: true, panelOpen: false }), {
    liveBrowser: "button",
    resume: "button button-secondary",
  });
});

test("attentionPanelActionClasses: live required + panel open → Resume primary, Hide secondary", () => {
  assert.deepEqual(attentionPanelActionClasses({ liveRequired: true, panelOpen: true }), {
    liveBrowser: "button button-secondary",
    resume: "button",
  });
});

test("attentionPanelActionClasses: live not required → both secondary when closed", () => {
  assert.deepEqual(attentionPanelActionClasses({ liveRequired: false, panelOpen: false }), {
    liveBrowser: "button button-secondary",
    resume: "button button-secondary",
  });
});

test("attentionPanelActionClasses: live not required + panel open → Resume primary", () => {
  assert.deepEqual(attentionPanelActionClasses({ liveRequired: false, panelOpen: true }), {
    liveBrowser: "button button-secondary",
    resume: "button",
  });
});
