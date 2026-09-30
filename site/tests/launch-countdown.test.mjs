import assert from "node:assert/strict";
import test from "node:test";
import {
  getLaunchDisplayState,
  HOSTED_CONTINUITY_STATUS,
  CLOUD_ACCESS_STATUS,
} from "../lib/launch-countdown.mjs";

test("soft-activate keeps Hosted READY while Cloud stays coming soon", () => {
  assert.equal(HOSTED_CONTINUITY_STATUS, "READY");
  assert.equal(CLOUD_ACCESS_STATUS, "COMING SOON");
  assert.deepEqual(
    getLaunchDisplayState({
      hostedContinuityStatus: HOSTED_CONTINUITY_STATUS,
      cloudAccessStatus: CLOUD_ACCESS_STATUS,
    }),
    {
      launchStateLabel: "HOSTED OPEN",
      hostedContinuityLabel: "READY",
      cloudAccessLabel: "COMING SOON",
      availabilityLabel: "Founding hosted open",
      message: "Hosted continuity is open for founding members. Cloud access is still coming soon.",
      cloudOpen: false,
      hostedOpen: true,
    },
  );
});

test("does not claim cloud access OPEN while Cloud status is still coming soon", () => {
  const display = getLaunchDisplayState({
    hostedContinuityStatus: HOSTED_CONTINUITY_STATUS,
    cloudAccessStatus: CLOUD_ACCESS_STATUS,
  });

  assert.equal(display.cloudOpen, false);
  assert.equal(display.hostedOpen, true);
  assert.equal(display.launchStateLabel, "HOSTED OPEN");
  assert.equal(display.hostedContinuityLabel, "READY");
  assert.equal(display.cloudAccessLabel, "COMING SOON");
  assert.match(display.message, /hosted continuity is open/i);
  assert.match(display.message, /coming soon/i);
  assert.doesNotMatch(display.message, /window is now open/i);
  assert.notEqual(display.cloudAccessLabel, "OPEN");
});

test("Hosted VERIFYING still blocks open framing for both surfaces", () => {
  const display = getLaunchDisplayState({
    hostedContinuityStatus: "VERIFYING",
    cloudAccessStatus: "COMING SOON",
  });

  assert.equal(display.cloudOpen, false);
  assert.equal(display.hostedOpen, false);
  assert.equal(display.launchStateLabel, "COMING SOON");
  assert.equal(display.hostedContinuityLabel, "VERIFYING");
  assert.equal(display.cloudAccessLabel, "COMING SOON");
  assert.match(display.message, /still verifying/i);
});

test("only claims cloud OPEN when Cloud status is explicitly OPEN", () => {
  const display = getLaunchDisplayState({
    hostedContinuityStatus: "READY",
    cloudAccessStatus: "OPEN",
  });

  assert.equal(display.cloudOpen, true);
  assert.equal(display.hostedOpen, true);
  assert.equal(display.launchStateLabel, "WINDOW OPEN");
  assert.equal(display.cloudAccessLabel, "OPEN");
  assert.equal(display.message, "The cloud launch window is now open.");
});
