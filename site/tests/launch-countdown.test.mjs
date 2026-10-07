import assert from "node:assert/strict";
import test from "node:test";
import {
  getLaunchDisplayState,
  CLOUD_ACCESS_STATUS,
} from "../lib/launch-countdown.mjs";

test("founding reservation keeps Cloud access COMING SOON", () => {
  assert.equal(CLOUD_ACCESS_STATUS, "COMING SOON");
  assert.deepEqual(
    getLaunchDisplayState({
      cloudAccessStatus: CLOUD_ACCESS_STATUS,
    }),
    {
      launchStateLabel: "COMING SOON",
      cloudAccessLabel: "COMING SOON",
      availabilityLabel: "Founding reservation open",
      message:
        "Cloud access is coming soon — a hosted agent that runs for you. Reserve the founding price now; we'll email you when it opens. No access window starts at payment.",
      cloudOpen: false,
    },
  );
});

test("does not claim cloud access OPEN while Cloud status is still coming soon", () => {
  const display = getLaunchDisplayState({
    cloudAccessStatus: CLOUD_ACCESS_STATUS,
  });

  assert.equal(display.cloudOpen, false);
  assert.equal(display.launchStateLabel, "COMING SOON");
  assert.equal(display.cloudAccessLabel, "COMING SOON");
  assert.match(display.message, /cloud access is coming soon/i);
  assert.match(display.message, /reserve the founding price/i);
  assert.doesNotMatch(display.message, /window is now open/i);
  assert.doesNotMatch(display.launchStateLabel, /HOSTED OPEN|READY/);
  assert.notEqual(display.cloudAccessLabel, "OPEN");
});

test("only claims cloud OPEN when Cloud status is explicitly OPEN", () => {
  const display = getLaunchDisplayState({
    cloudAccessStatus: "OPEN",
  });

  assert.equal(display.cloudOpen, true);
  assert.equal(display.launchStateLabel, "WINDOW OPEN");
  assert.equal(display.cloudAccessLabel, "OPEN");
  assert.equal(display.message, "The cloud launch window is now open.");
});
