const SECOND_MS = 1_000;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;
const DAY_SECONDS = 24 * HOUR_SECONDS;

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
