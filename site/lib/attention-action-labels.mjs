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

/** Buyer-facing blocker chips — Quiet Trust (no raw kebab enums). */
export const BLOCKER_LABELS = {
  captcha: "CAPTCHA",
  authentication: "Sign-in",
  mfa: "Multi-factor",
  "legal-attestation": "Legal attestation",
  judgment: "Judgment answer",
  demographic: "Demographic question",
  "government-id": "Government ID",
  "ambiguous-authorization": "Work authorization",
  "ambiguous-compensation": "Compensation",
  "unverifiable-claim": "Unverified fact",
  video: "Video prompt",
  upload: "Upload",
  "site-error": "Site error",
  other: "Paused",
  paused: "Paused",
};

/**
 * @param {string} action
 * @returns {string}
 */
export function actionLabel(action) {
  return ACTION_LABELS[action] ?? action;
}

/**
 * @param {string} blocker
 * @returns {string}
 */
export function blockerLabel(blocker) {
  const key = String(blocker ?? "").trim().toLowerCase();
  if (!key) return BLOCKER_LABELS.paused;
  return BLOCKER_LABELS[key] ?? key.replace(/-/g, " ");
}
