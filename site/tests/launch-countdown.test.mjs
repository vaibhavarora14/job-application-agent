import assert from "node:assert/strict";
import test from "node:test";
import {
  getLaunchDisplayState,
  HOSTED_CONTINUITY_STATUS,
} from "../lib/launch-countdown.mjs";

test("keeps cloud access coming soon while Hosted continuity is VERIFYING", () => {
  assert.deepEqual(
    getLaunchDisplayState({ hostedContinuityStatus: HOSTED_CONTINUITY_STATUS }),
    {
      launchStateLabel: "COMING SOON",
      hostedContinuityLabel: "VERIFYING",
      cloudAccessLabel: "COMING SOON",
      message: "Cloud access is coming soon. Hosted continuity is still verifying — cloud access is not open yet.",
      cloudOpen: false,
    },
  );
});

test("does not claim cloud access OPEN while Hosted is still VERIFYING", () => {
  const display = getLaunchDisplayState({
    hostedContinuityStatus: HOSTED_CONTINUITY_STATUS,
  });

  assert.equal(HOSTED_CONTINUITY_STATUS, "VERIFYING");
  assert.equal(display.cloudOpen, false);
  assert.equal(display.launchStateLabel, "COMING SOON");
  assert.equal(display.hostedContinuityLabel, "VERIFYING");
  assert.equal(display.cloudAccessLabel, "COMING SOON");
  assert.match(display.message, /coming soon/i);
  assert.match(display.message, /still verifying/i);
  assert.doesNotMatch(display.message, /window is now open/i);
  assert.notEqual(display.launchStateLabel, "WINDOW OPEN");
  assert.notEqual(display.cloudAccessLabel, "OPEN");
});

test("only claims cloud OPEN after Hosted continuity leaves VERIFYING", () => {
  const display = getLaunchDisplayState({
    hostedContinuityStatus: "READY",
  });

  assert.equal(display.cloudOpen, true);
  assert.equal(display.launchStateLabel, "WINDOW OPEN");
  assert.equal(display.cloudAccessLabel, "OPEN");
  assert.equal(display.message, "The cloud launch window is now open.");
});
