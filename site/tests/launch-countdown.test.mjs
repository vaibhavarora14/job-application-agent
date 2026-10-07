import assert from "node:assert/strict";
import test from "node:test";
import {
  getLaunchDisplayState,
  HOSTED_CONTINUITY_STATUS,
  CLOUD_ACCESS_STATUS,
} from "../lib/launch-countdown.mjs";

test("founding reservation keeps Hosted and Cloud COMING SOON", () => {
  assert.equal(HOSTED_CONTINUITY_STATUS, "COMING SOON");
  assert.equal(CLOUD_ACCESS_STATUS, "COMING SOON");
  assert.deepEqual(
    getLaunchDisplayState({
      hostedContinuityStatus: HOSTED_CONTINUITY_STATUS,
      cloudAccessStatus: CLOUD_ACCESS_STATUS,
    }),
    {
      launchStateLabel: "COMING SOON",
      hostedContinuityLabel: "COMING SOON",
      cloudAccessLabel: "COMING SOON",
      availabilityLabel: "Founding reservation open",
      message: "Hosted access is coming soon. Reserve the founding price now — we'll email you when seats go live. No access window starts at payment.",
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
  assert.equal(display.launchStateLabel, "COMING SOON");
  assert.equal(display.hostedContinuityLabel, "COMING SOON");
  assert.equal(display.cloudAccessLabel, "COMING SOON");
  assert.match(display.message, /hosted access is coming soon/i);
  assert.match(display.message, /reserve the founding price/i);
  assert.doesNotMatch(display.message, /window is now open/i);
  assert.doesNotMatch(display.launchStateLabel, /HOSTED OPEN|READY/);
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
    hostedContinuityStatus: "COMING SOON",
    cloudAccessStatus: "OPEN",
  });

  assert.equal(display.cloudOpen, true);
  assert.equal(display.hostedOpen, true);
  assert.equal(display.launchStateLabel, "WINDOW OPEN");
  assert.equal(display.cloudAccessLabel, "OPEN");
  assert.equal(display.message, "The cloud launch window is now open.");
});
