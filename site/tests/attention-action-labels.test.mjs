import assert from "node:assert/strict";
import test from "node:test";

import { ACTION_LABELS, actionLabel } from "../lib/attention-action-labels.mjs";

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
