import assert from "node:assert/strict";
import test from "node:test";
import { getCountdownParts } from "../lib/launch-countdown.mjs";

test("breaks the remaining launch time into stable day, hour, minute, and second units", () => {
  assert.deepEqual(
    getCountdownParts("2026-09-18T00:00:00+05:30", "2026-09-16T21:56:55+05:30"),
    { days: 1, hours: 2, minutes: 3, seconds: 5, complete: false },
  );
});

test("stops the reverse timer at zero when the launch window opens", () => {
  assert.deepEqual(
    getCountdownParts("2026-09-18T00:00:00+05:30", "2026-09-18T00:00:01+05:30"),
    { days: 0, hours: 0, minutes: 0, seconds: 0, complete: true },
  );
});

test("does not report launch complete during the final fractional second", () => {
  assert.deepEqual(
    getCountdownParts("2026-09-18T00:00:00.000Z", "2026-09-17T23:59:59.500Z"),
    { days: 0, hours: 0, minutes: 0, seconds: 1, complete: false },
  );
});

test("rejects an invalid launch schedule instead of displaying misleading time", () => {
  assert.throws(() => getCountdownParts("not-a-date", "2026-09-01T00:00:00Z"), /launch schedule/i);
});
