// Shared by the CLI and the telemetry relay (no Node-only imports: the relay runs on Workers).
// Home-directory paths carry the OS username, so they are collapsed to `~` before any
// string can reach analytics. Covers POSIX (/home/x, /Users/x, /var/home/x, WSL /mnt/c/Users/x),
// Windows drive and UNC-style forms (C:\Users\x, C:/Users/x, \\host\c$\Users\x), the legacy
// "Documents and Settings" root, and file:// URLs that wrap any of these.

const WORD = String.raw`[^\\/\s'"\x60:;,)\]}>]+`;
// A username may contain spaces ("Jane Doe"); multi-word names are consumed only when a path
// separator follows, so ordinary prose after a bare home path is not swallowed.
const SEGMENT = String.raw`(?:${WORD}(?: ${WORD})*(?=[\\/])|${WORD})`;
const POSIX_HOME = new RegExp(String.raw`(?:file:\/\/)?(?:\/mnt\/[A-Za-z])?\/(?:home|Users|var\/home|export\/home|usr\/home)\/${SEGMENT}`, 'g');
const WINDOWS_HOME = new RegExp(String.raw`(?:file:\/{2,3})?(?:\\\\[^\\/\s]+\\[A-Za-z]\$|[A-Za-z]:)[\\/]+(?:Users|Documents and Settings)[\\/]+${SEGMENT}`, 'gi');

export function redactHomePaths(value) {
  if (typeof value !== 'string' || !value) return value;
  return value.replace(WINDOWS_HOME, '~').replace(POSIX_HOME, '~');
}

// Property keys that carry direct identity. No analytics schema property uses these names, so the
// relay drops them if an outdated client (3.7.2 and earlier) still sends them.
export const TELEMETRY_PII_KEYS = Object.freeze([
  'candidateName', 'candidateEmail', 'candidatePhone', 'name', 'email', 'phone', 'firstName', 'lastName',
  'fullName', 'emailAddress', 'phoneNumber', 'mobile', 'username', 'userName', '$set', '$set_once',
  '$identify', '$anon_distinct_id', '$name', '$email', '$phone',
]);

const PII_KEY_SET = new Set(TELEMETRY_PII_KEYS.map((key) => key.toLowerCase()));

export function isTelemetryPiiKey(key) {
  return typeof key === 'string' && PII_KEY_SET.has(key.toLowerCase());
}
