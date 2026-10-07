/**
 * Cloud access stays soft "coming soon" until its own flip.
 * One product story: cloud access / hosted agent — not dual Hosted + Cloud lanes.
 * Soft timing only — never imply a calendar launch date.
 */
export const CLOUD_ACCESS_STATUS = "COMING SOON";

/**
 * Map cloud readiness to public launch UI copy.
 *
 * @param {{ cloudAccessStatus?: string }} [options]
 */
export function getLaunchDisplayState({
  cloudAccessStatus = CLOUD_ACCESS_STATUS,
} = {}) {
  const cloudOpen = cloudAccessStatus === "OPEN";

  if (cloudOpen) {
    return {
      launchStateLabel: "WINDOW OPEN",
      cloudAccessLabel: "OPEN",
      availabilityLabel: "Cloud open",
      message: "The cloud launch window is now open.",
      cloudOpen: true,
    };
  }

  return {
    launchStateLabel: "COMING SOON",
    cloudAccessLabel: "COMING SOON",
    availabilityLabel: "Founding reservation open",
    message:
      "Cloud access is coming soon — a hosted agent that runs for you. Reserve the founding price now; we'll email you when it opens. No access window starts at payment.",
    cloudOpen: false,
  };
}
