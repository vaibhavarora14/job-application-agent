const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

/** Hosted continuity stays VERIFYING until the hosted executor actually works. */
export const HOSTED_CONTINUITY_STATUS = "VERIFYING";

export function getCountdownParts(releaseAt, now = Date.now()) {
  const releaseTime = new Date(releaseAt).getTime();
  const nowTime = new Date(now).getTime();

  if (!Number.isFinite(releaseTime)) throw new TypeError("A valid launch schedule is required.");
  if (!Number.isFinite(nowTime)) throw new TypeError("A valid time reference is required.");

  const remainingSeconds = Math.max(0, Math.ceil((releaseTime - nowTime) / SECOND_MS));

  return {
    days: Math.floor(remainingSeconds / DAY_SECONDS),
    hours: Math.floor((remainingSeconds % DAY_SECONDS) / HOUR_SECONDS),
    minutes: Math.floor((remainingSeconds % HOUR_SECONDS) / MINUTE_SECONDS),
    seconds: remainingSeconds % MINUTE_SECONDS,
    complete: remainingSeconds === 0,
  };
}

/**
 * Map timer completion + hosted readiness to public launch UI copy.
 * Reaching the marketing date alone must not imply activatable cloud access.
 *
 * @param {{ complete?: boolean, hostedContinuityStatus?: string }} [options]
 */
export function getLaunchDisplayState({
  complete = false,
  hostedContinuityStatus = HOSTED_CONTINUITY_STATUS,
} = {}) {
  const hostedVerifying = hostedContinuityStatus === "VERIFYING";

  if (!complete) {
    return {
      launchStateLabel: "T− ACTIVE",
      hostedContinuityLabel: hostedContinuityStatus,
      cloudAccessLabel: "SCHEDULED",
      message: "The timer is synced to the scheduled India launch window.",
      timerComplete: false,
      cloudOpen: false,
    };
  }

  if (hostedVerifying) {
    return {
      launchStateLabel: "DATE REACHED",
      hostedContinuityLabel: "VERIFYING",
      cloudAccessLabel: "SCHEDULED",
      message: "The scheduled launch date has been reached. Hosted continuity is still verifying — cloud access is not open yet.",
      timerComplete: true,
      cloudOpen: false,
    };
  }

  return {
    launchStateLabel: "WINDOW OPEN",
    hostedContinuityLabel: hostedContinuityStatus,
    cloudAccessLabel: "OPEN",
    message: "The cloud launch window is now open.",
    timerComplete: true,
    cloudOpen: true,
  };
}
