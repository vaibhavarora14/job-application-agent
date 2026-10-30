// Current-location answers for `review stage`.
//
// A form question such as "What is your current location?" must never be staged with an empty
// answer: `review stage` rejects it (invalid_input) and, before this module, the whole batch failed
// and the round could end with no submits and no visible reason. These pure helpers fill such an
// answer from the profile's location fields, and report the items where the profile has none so
// the CLI can open an attention item for the candidate instead.

// Questions that ask where the candidate is now (not where they want to work or relocate to).
const CURRENT_LOCATION_PATTERNS = Object.freeze([
  /\bcurrent(?:ly)?\s+(?:home\s+)?(?:location|city|address|residence|country|state|place\s+of\s+residence)\b/i,
  /\bwhere\s+(?:are|do)\s+you\s+(?:currently\s+|now\s+)?(?:located|based|live|living|reside|residing)\b/i,
  /\b(?:city|country|state|place|location)\s+of\s+(?:current\s+)?residence\b/i,
  /\b(?:what|which)\s+(?:city|town|country|state|location)\s+(?:are|do)\s+you\s+(?:currently\s+|now\s+)?(?:in|live|living|based|located|reside|residing)\b/i,
  /\b(?:home|residential)\s+(?:city|location|address)\b/i,
  // A bare "Location" / "City" / "Location (city, country)" field label.
  /^\s*(?:your\s+)?(?:location|city)(?:\s*\([^)]*\))?\s*[?:*]*\s*$/i,
]);
// Preference questions that mention a location but do not ask for the current one.
const NOT_CURRENT_LOCATION = /\b(?:prefer(?:red|ence)?|relocat\w*|willing|open\s+to|desired|target|work\s+location|office\s+location|commut\w*)\b/i;
const GENERIC_PLACES = /^(?:remote|worldwide|anywhere|global|any|flexible|n\/?a)$/i;
// Profile fields that state the candidate's current location exactly; anything else is a fallback
// the candidate is asked to check on the review page.
const EXACT_SOURCES = new Set(['currentLocation', 'location']);

function presentString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** True when an answer key reads like a current-location question. */
export function isCurrentLocationQuestion(label) {
  const text = String(label ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text.length > 300) return false;
  if (NOT_CURRENT_LOCATION.test(text)) return false;
  return CURRENT_LOCATION_PATTERNS.some((pattern) => pattern.test(text));
}

function joinParts(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts.map(presentString).filter(Boolean)) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.length ? out.join(', ') : null;
}

/**
 * The best current-location value the profile holds, or null.
 * Order: currentLocation, location, city/state/country, address, then the first specific
 * preferred/target location (generic entries such as "Remote" or "Worldwide" never count).
 * @returns {{ value: string, source: string, exact: boolean } | null}
 */
export function profileCurrentLocation(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return null;
  for (const key of ['currentLocation', 'location']) {
    const value = presentString(profile[key]);
    if (value) return { value, source: key, exact: true };
  }
  const parts = joinParts([profile.city, profile.state ?? profile.region ?? profile.province, profile.country]);
  if (parts) return { value: parts, source: 'city/state/country', exact: false };
  const address = profile.address;
  const addressValue = presentString(address)
    ?? (address && typeof address === 'object' && !Array.isArray(address)
      ? joinParts([address.city ?? address.locality, address.state ?? address.region ?? address.province, address.country])
      : null);
  if (addressValue) return { value: addressValue, source: 'address', exact: false };
  for (const key of ['preferredLocations', 'targetLocations']) {
    const list = Array.isArray(profile[key]) ? profile[key] : [];
    const value = list.map(presentString).find((item) => item && !GENERIC_PLACES.test(item));
    if (value) return { value, source: key, exact: false };
  }
  return null;
}

const isEmptyAnswer = (value) => value == null || (typeof value === 'string' && !value.trim());

/** Answer keys in one staged item that are current-location questions with an empty answer. */
export function emptyCurrentLocationAnswers(item) {
  if (item?.type !== 'application' || !item.answers || typeof item.answers !== 'object' || Array.isArray(item.answers)) return [];
  return Object.entries(item.answers).filter(([key, value]) => isEmptyAnswer(value) && isCurrentLocationQuestion(key)).map(([key]) => key);
}

/**
 * Fill empty current-location answers in `review stage` items from the profile.
 * Never edits a non-empty answer. Fallback (non-exact) values are added to flaggedAnswers so the
 * candidate checks them on the review page before approving.
 * @returns {{ items: object[], filled: { index: number, applicationId: string|null, answer: string, source: string }[], missing: { index: number, applicationId: string|null, answers: string[] }[] }}
 */
export function fillCurrentLocationAnswers(items, profile) {
  const list = Array.isArray(items) ? items : [];
  const location = profileCurrentLocation(profile);
  const filled = [];
  const missing = [];
  const next = list.map((item, index) => {
    const keys = emptyCurrentLocationAnswers(item);
    if (!keys.length) return item;
    const applicationId = typeof item.applicationId === 'string' ? item.applicationId : null;
    if (!location) {
      missing.push({ index, applicationId, answers: keys });
      return item;
    }
    const answers = { ...item.answers };
    // Leave a malformed flaggedAnswers alone: `review stage` rejects it with its own message.
    const canFlag = item.flaggedAnswers == null || Array.isArray(item.flaggedAnswers);
    const existing = Array.isArray(item.flaggedAnswers) ? item.flaggedAnswers : [];
    const flags = [...existing];
    for (const key of keys) {
      answers[key] = location.value;
      filled.push({ index, applicationId, answer: key, source: location.source });
      if (!location.exact && canFlag && !flags.some((flag) => flag?.answer === key)) {
        flags.push({ answer: key, reason: `Filled from your profile's ${location.source}; your profile has no current location. Check it is where you live now.` });
      }
    }
    const out = { ...item, answers };
    if (flags.length !== existing.length) out.flaggedAnswers = flags;
    return out;
  });
  return { items: next, filled, missing };
}
