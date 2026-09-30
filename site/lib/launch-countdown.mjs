/** Hosted continuity stays VERIFYING until the hosted executor actually works. */
export const HOSTED_CONTINUITY_STATUS = "VERIFYING";

/**
 * Map hosted readiness to public launch UI copy.
 * Soft timing only — never imply a calendar launch date.
 * Hosted VERIFYING must never imply activatable cloud access (OPEN).
 *
 * @param {{ hostedContinuityStatus?: string }} [options]
 */
export function getLaunchDisplayState({
  hostedContinuityStatus = HOSTED_CONTINUITY_STATUS,
} = {}) {
  const hostedVerifying = hostedContinuityStatus === "VERIFYING";

  if (hostedVerifying) {
    return {
      launchStateLabel: "COMING SOON",
      hostedContinuityLabel: "VERIFYING",
      cloudAccessLabel: "COMING SOON",
      message: "Cloud access is coming soon. Hosted continuity is still verifying — cloud access is not open yet.",
      cloudOpen: false,
    };
  }

  return {
    launchStateLabel: "WINDOW OPEN",
    hostedContinuityLabel: hostedContinuityStatus,
    cloudAccessLabel: "OPEN",
    message: "The cloud launch window is now open.",
    cloudOpen: true,
  };
}
