/** Hosted continuity is READY for founding activators (soft-activate). */
export const HOSTED_CONTINUITY_STATUS = "READY";

/**
 * Cloud product stays soft "coming soon" until its own flip.
 * Independent of Hosted — Hosted READY must not imply Cloud OPEN.
 */
export const CLOUD_ACCESS_STATUS = "COMING SOON";

/**
 * Map hosted + cloud readiness to public launch UI copy.
 * Soft timing only — never imply a calendar launch date.
 * Hosted VERIFYING must never imply activatable cloud access (OPEN).
 * Hosted READY with Cloud still coming soon is the soft-activate founding state.
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
    launchStateLabel: "HOSTED OPEN",
    hostedContinuityLabel: hostedContinuityStatus,
    cloudAccessLabel,
    availabilityLabel: "Founding hosted open",
    message: "Hosted continuity is open for founding members. Cloud access is still coming soon.",
    cloudOpen: false,
    hostedOpen: true,
  };
}
