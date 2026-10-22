/**
 * Redact personal data from upstream error text before it reaches Worker logs.
 * Cloudflare retains Worker logs, so log lines must never carry buyer emails.
 */
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/**
 * @param {unknown} value
 * @param {number} [max]
 */
export function redactLogDetail(value, max = 200) {
  return String(value ?? "").replace(EMAIL_PATTERN, "[email]").slice(0, max);
}
