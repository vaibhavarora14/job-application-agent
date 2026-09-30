import assert from "node:assert/strict";
import test from "node:test";
import {
  getCountdownParts,
  getLaunchDisplayState,
  HOSTED_CONTINUITY_STATUS,
} from "../lib/launch-countdown.mjs";

test("breaks the remaining launch time into stable day, hour, minute, and second units", () => {
  assert.deepEqual(
    getCountdownParts("2026-10-01T00:00:00+05:30", "2026-09-29T21:56:55+05:30"),
    { days: 1, hours: 2, minutes: 3, seconds: 5, complete: false },
  );
});

test("stops the reverse timer at zero after the scheduled launch instant", () => {
  assert.deepEqual(
    getCountdownParts("2026-10-01T00:00:00+05:30", "2026-10-01T00:00:01+05:30"),
    { days: 0, hours: 0, minutes: 0, seconds: 0, complete: true },
  );
});

test("does not report launch complete during the final fractional second", () => {
  assert.deepEqual(
    getCountdownParts("2026-10-01T00:00:00.000Z", "2026-09-30T23:59:59.500Z"),
    { days: 0, hours: 0, minutes: 0, seconds: 1, complete: false },
  );
});

test("rejects an invalid launch schedule instead of displaying misleading time", () => {
  assert.throws(() => getCountdownParts("not-a-date", "2026-09-01T00:00:00Z"), /launch schedule/i);
});

test("rejects an invalid current time instead of displaying a misleading countdown", () => {
  assert.throws(() => getCountdownParts("2026-10-01T00:00:00+05:30", "not-a-date"), /time reference/i);
});

test("keeps cloud access scheduled before the marketing date", () => {
  assert.deepEqual(
    getLaunchDisplayState({ complete: false, hostedContinuityStatus: HOSTED_CONTINUITY_STATUS }),
    {
      launchStateLabel: "T− ACTIVE",
      hostedContinuityLabel: "VERIFYING",
      cloudAccessLabel: "SCHEDULED",
      message: "The timer is synced to the scheduled India launch window.",
      timerComplete: false,
      cloudOpen: false,
    },
  );
});

test("does not claim cloud access OPEN when the date is reached but Hosted is still VERIFYING", () => {
  const display = getLaunchDisplayState({
    complete: true,
    hostedContinuityStatus: HOSTED_CONTINUITY_STATUS,
  });

  assert.equal(HOSTED_CONTINUITY_STATUS, "VERIFYING");
  assert.equal(display.timerComplete, true);
  assert.equal(display.cloudOpen, false);
  assert.equal(display.launchStateLabel, "DATE REACHED");
  assert.equal(display.hostedContinuityLabel, "VERIFYING");
  assert.equal(display.cloudAccessLabel, "SCHEDULED");
  assert.match(display.message, /still verifying/i);
  assert.doesNotMatch(display.message, /window is now open/i);
  assert.notEqual(display.launchStateLabel, "WINDOW OPEN");
  assert.notEqual(display.cloudAccessLabel, "OPEN");
});

test("only claims cloud OPEN after Hosted continuity leaves VERIFYING", () => {
  const display = getLaunchDisplayState({
    complete: true,
    hostedContinuityStatus: "READY",
  });

  assert.equal(display.cloudOpen, true);
  assert.equal(display.launchStateLabel, "WINDOW OPEN");
  assert.equal(display.cloudAccessLabel, "OPEN");
  assert.equal(display.message, "The cloud launch window is now open.");
});
