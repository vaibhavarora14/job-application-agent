import assert from "node:assert/strict";
import test from "node:test";

import { activationWindow, isRefundDue } from "../lib/purchase-lifecycle.mjs";

test("starts the 30-day entitlement only when access is activated", () => {
  assert.deepEqual(activationWindow("2026-10-01T12:00:00.000Z"), {
    activatedAt: "2026-10-01T12:00:00.000Z",
    accessExpiresAt: "2026-10-31T12:00:00.000Z",
  });
});

test("preserves the 90-day entitlement promised to earlier purchases", () => {
  assert.deepEqual(activationWindow("2026-10-01T12:00:00.000Z", 90), {
    activatedAt: "2026-10-01T12:00:00.000Z",
    accessExpiresAt: "2026-12-30T12:00:00.000Z",
  });
});

test("refunds only succeeded purchases that remain unactivated for 60 days", () => {
  const now = new Date("2026-10-20T00:00:00.000Z");
  assert.equal(isRefundDue({ status: "succeeded", paidAt: "2026-08-20T00:00:00.000Z", activatedAt: null }, now), true);
  assert.equal(isRefundDue({ status: "succeeded", paidAt: "2026-08-22T00:00:00.000Z", activatedAt: null }, now), false);
  assert.equal(isRefundDue({ status: "succeeded", paidAt: "2026-08-01T00:00:00.000Z", activatedAt: "2026-09-01T00:00:00.000Z" }, now), false);
  assert.equal(isRefundDue({ status: "refunded", paidAt: "2026-08-01T00:00:00.000Z", activatedAt: null }, now), false);
});
