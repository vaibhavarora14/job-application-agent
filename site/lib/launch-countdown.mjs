/** Hosted continuity stays COMING SOON while founding reservation is open. */
export const HOSTED_CONTINUITY_STATUS = "COMING SOON";

/**
 * Cloud product stays soft "coming soon" until its own flip.
 * Independent of Hosted — Hosted reservation must not imply Cloud OPEN.
 */
export const CLOUD_ACCESS_STATUS = "COMING SOON";

/**
 * Map hosted + cloud readiness to public launch UI copy.
 * Soft timing only — never imply a calendar launch date.
 * Hosted VERIFYING must never imply activatable cloud access (OPEN).
 * Default founding state: both Hosted and Cloud COMING SOON, with
 * Hosted alone owning the founding-reservation path (no OPEN/READY).
 *
 * @param {{ hostedContinuityStatus?: string, cloudAccessStatus?: string }} [options]
 */
export function getLaunchDisplayState({
  hostedContinuityStatus = HOSTED_CONTINUITY_STATUS,
  cloudAccessStatus = CLOUD_ACCESS_STATUS,
} = {}) {
  const hostedVerifying = hostedContinuityStatus === "VERIFYING";
  const cloudOpen = cloudAccessStatus === "OPEN";
  const cloudAccessLabel = cloudOpen ? "OPEN" : "COMING SOON";

  if (hostedVerifying) {
    return {
      launchStateLabel: "COMING SOON",
      hostedContinuityLabel: "VERIFYING",
      cloudAccessLabel,
      availabilityLabel: "Coming soon",
      message: "Cloud access is coming soon. Hosted continuity is still verifying — cloud access is not open yet.",
      cloudOpen: false,
      hostedOpen: false,
    };
  }

  if (cloudOpen) {
    return {
      launchStateLabel: "WINDOW OPEN",
      hostedContinuityLabel: hostedContinuityStatus,
      cloudAccessLabel: "OPEN",
      availabilityLabel: "Cloud open",
      message: "The cloud launch window is now open.",
      cloudOpen: true,
      hostedOpen: true,
    };
  }

  return {
    launchStateLabel: "COMING SOON",
    hostedContinuityLabel: hostedContinuityStatus,
    cloudAccessLabel,
    availabilityLabel: "Founding reservation open",
    message: "Hosted access is coming soon. Reserve the founding price now — we'll email you when seats go live. No access window starts at payment.",
    cloudOpen: false,
    hostedOpen: true,
  };
}
