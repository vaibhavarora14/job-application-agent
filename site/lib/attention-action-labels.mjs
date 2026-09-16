/** Human-readable labels for attention required-action codes (server-safe). */

export const ACTION_LABELS = {
  "sign-in": "Sign in",
  "complete-mfa": "Complete MFA",
  "complete-captcha": "Complete CAPTCHA",
  "review-legal": "Review legal attestation",
  "choose-demographic": "Choose demographic response",
  "provide-government-id": "Handle government ID",
  "provide-authorization": "Provide work authorization",
  "provide-compensation": "Provide compensation",
  "verify-claim": "Verify missing fact",
  "provide-judgment": "Provide judgment answer",
  "record-video": "Record video",
  "enable-upload": "Complete upload",
  "retry-site": "Retry site",
};

/**
 * @param {string} action
 * @returns {string}
 */
export function actionLabel(action) {
  return ACTION_LABELS[action] ?? action;
}
