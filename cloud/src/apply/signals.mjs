const HARD_STOPS = [
  { blocker: 'authentication', pattern: /\b(sign in|log in|login|sso|single sign[- ]on|continue with google|continue with okta)\b/i, stage: 'application' },
  { blocker: 'mfa', pattern: /\b(multi[- ]factor|two[- ]factor|2fa|verification code|authenticator)\b/i, stage: 'application' },
  { blocker: 'captcha', pattern: /\b(captcha|recaptcha|hcaptcha|i am not a robot)\b/i, stage: 'application' },
  { blocker: 'demographic', pattern: /\b(gender|ethnicity|race|veteran status|disability|sexual orientation|eeo)\b/i, stage: 'demographic' },
  { blocker: 'government-id', pattern: /\b(social security|ssn|aadhaar|passport number|national id|government id)\b/i, stage: 'legal' },
  { blocker: 'legal-attestation', pattern: /\b(i agree to the|terms of (use|service)|privacy policy|certify that the information)\b/i, stage: 'legal' },
  { blocker: 'other', pattern: /\bapply with linkedin\b/i, stage: 'application' },
];

const CONFIRMATION = /\b(thank you|thanks for (applying|your application)|application (has been )?(received|submitted|sent)|successfully (submitted|applied)|we('ve| have) received your (application|submission))\b/i;

export function detectHardStops(pageText, { hasLinkedInOverlay = false } = {}) {
  if (hasLinkedInOverlay) {
    return { blocker: 'authentication', stage: 'application', reason: 'Apply with LinkedIn overlay' };
  }
  const text = String(pageText || '');
  for (const stop of HARD_STOPS) {
    if (stop.pattern.test(text)) return { blocker: stop.blocker, stage: stop.stage, reason: `Page matched ${stop.blocker}` };
  }
  return null;
}

export function confirmationLooksSuccessful(pageText, url = '') {
  const text = String(pageText || '');
  const href = String(url || '').toLowerCase();
  if (CONFIRMATION.test(text)) return { ok: true, excerpt: text.match(CONFIRMATION)?.[0] || 'thank-you' };
  if (/\/(thanks|thank-you|confirmation|submitted)\b/.test(href) && /application|applied|received|thank/i.test(text)) {
    return { ok: true, excerpt: 'confirmation-url' };
  }
  return { ok: false };
}

export function looksAmbiguous(pageText, kind) {
  const text = String(pageText || '').toLowerCase();
  if (kind === 'authorization') return /\b(authorized to work|sponsorship|visa)\b/.test(text);
  if (kind === 'compensation') return /\b(salary|compensation|expected pay)\b/.test(text);
  return false;
}
