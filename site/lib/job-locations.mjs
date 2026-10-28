const label = value => typeof value === 'string' && value.trim().length <= 240 && !/[<>]/.test(value) && ![...value].some(char => char.charCodeAt(0) < 32) ? value.trim() : '';
const unique = values => [...new Set(values.filter(Boolean))];

export function countryLabel(value) {
  if (['USA', 'United States of America'].includes(value)) return 'United States';
  if (value === 'UK') return 'United Kingdom';
  if (!/^[A-Za-z]{2}$/.test(value)) return value;
  return new Intl.DisplayNames(['en'], { type: 'region' }).of(value.toUpperCase()) ?? value;
}

export function locationText(location) {
  if (!location) return '';
  return [location.label, ...location.cities, ...location.countries, ...location.countries.map(countryLabel)].join(' ');
}

export const canonical = value => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname.replace(/\/(?:apply|application)\/?$/, '').replace(/\/$/, '')}`;
  } catch {
    return '';
  }
};

const title = value => label(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function titlesMatch(atsTitle, jobTitle) {
  const a = title(atsTitle);
  const b = title(jobTitle);
  if (!a || !b) return false;
  if (a === b) return true;
  const stripSuffix = val => label(val)
    .replace(/\s*\([^)]*\)$/, '')
    .replace(/\s*-[^-]+$/, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const aClean = stripSuffix(atsTitle);
  const bClean = stripSuffix(jobTitle);
  if (aClean === b || a === bClean || (aClean && aClean === bClean)) return true;
  if (a.length > 8 && b.length > 8 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

export function atsTarget(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const parts = url.pathname.split('/').filter(Boolean).filter(part => !['apply', 'application'].includes(part));
  if (parts.length < 2) return null;

  if (url.hostname === 'jobs.ashbyhq.com') {
    const [board, id] = parts;
    if (/^[\w.-]+$/.test(board) && /^[\w-]+$/.test(id)) {
      return { kind: 'ashby', id, url: `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true` };
    }
  }

  if (['boards.greenhouse.io', 'job-boards.greenhouse.io', 'job-boards.eu.greenhouse.io'].includes(url.hostname)) {
    const [board, segment, id] = parts;
    if (segment === 'jobs' && /^\d+$/.test(id) && /^[\w-]+$/.test(board)) {
      return { kind: 'greenhouse', id, url: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?pay_transparency=true` };
    }
  }

  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname)) {
    const [board, id] = parts;
    if (/^[\w-]+$/.test(board) && /^[\w-]+$/.test(id)) {
      return { kind: 'lever', id, url: `https://${url.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${board}/${id}` };
    }
  }

  if (url.hostname === 'apply.workable.com') {
    const [account, segment, id] = parts;
    if (segment === 'j' && /^[\w-]+$/.test(account) && /^[\w-]+$/.test(id)) {
      return { kind: 'workable', id, url: `https://apply.workable.com/api/v2/accounts/${account}/jobs/${id}` };
    }
  }

  return null;
}

const HTML_ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&mdash;': '—',
  '&ndash;': '–'
};

/**
 * What a stated pay figure covers: `ote` (on-target earnings incl. variable pay), `total`
 * (total compensation) or `base`. Only `base` may be published as Schema.org baseSalary.
 * @returns {'base' | 'ote' | 'total'}
 */
export function compensationKind(text) {
  const value = String(text ?? '');
  if (/\bOTE\b|on[- ]target[- ]earnings?/i.test(value)) return 'ote';
  if (/total[- ](?:cash[- ]|target[- ]|annual[- ])?comp(?:ensation)?\b|\bTC\b|total[- ]rewards?/i.test(value)) return 'total';
  return 'base';
}

export function parseSalaryDetails(text) {
  if (!text || typeof text !== 'string') return null;
  const clean = text
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp|mdash|ndash);/g, match => HTML_ENTITIES[match] || match)
    .replace(/<[^>]+>/g, ' ');

  const rangeRegex = /(?:([$€£]|CAD\s*\$|USD\s*\$)\s*)?([\d,]+(?:\.\d+)?)\s*([kK])?\s*(?:[-–—]|to)\s*([$€£]|CAD\s*\$|USD\s*\$)?\s*([\d,]+(?:\.\d+)?)\s*([kK])?\s*(USD|EUR|GBP|CAD)?(?:\s*(?:\/|\bper\b)\s*(year|yr|annum|annual|month|mo|hour|hr))?/i;
  const singleRegex = /(?:([$€£]|CAD\s*\$|USD\s*\$)\s*)?([\d,]+(?:\.\d+)?)\s*([kK])?\s*(USD|EUR|GBP|CAD)?(?:\s*(?:\/|\bper\b)\s*(year|yr|annum|annual|month|mo|hour|hr))?/i;

  const keywords = /(?:salary|compensation|pay\s+range|pay\s+rate|remuneration|wage|ote|base\s+pay)[^.\n;]{0,120}/gi;
  let candidates = [];
  let kw;
  while ((kw = keywords.exec(clean)) !== null) {
    candidates.push(kw[0]);
  }
  if (candidates.length === 0) {
    // If no keyword sentence, check for prominent explicit range patterns
    const m = clean.match(/[$€£]\s*[\d,]+\s*(?:k|K)?\s*[-–—]\s*[$€£]?\s*[\d,]+\s*(?:k|K)?/);
    if (m) candidates.push(m[0]);
  }

  for (const cand of candidates) {
    const rm = cand.match(rangeRegex);
    if (rm && (rm[1] || rm[4] || rm[3] || rm[6] || rm[7] || rm[8])) {
      const currSymbol = rm[1] || rm[4] || '$';
      const currency = rm[7] || (currSymbol.includes('€') ? 'EUR' : currSymbol.includes('£') ? 'GBP' : currSymbol.includes('CAD') ? 'CAD' : 'USD');
      let min = parseFloat(rm[2].replace(/,/g, ''));
      let max = parseFloat(rm[5].replace(/,/g, ''));
      if (rm[3] || (rm[6] && min < 1000)) min *= 1000;
      if (rm[6]) max *= 1000;
      if (min < 1000 && max < 1000 && (rm[0].includes('k') || rm[0].includes('K'))) {
        min *= 1000; max *= 1000;
      }
      const period = rm[8] ? (rm[8].startsWith('m') ? 'month' : rm[8].startsWith('h') ? 'hour' : 'year') : (min > 30000 ? 'year' : min > 3000 ? 'month' : 'hour');
      if (min > 0 && max >= min && max < 2000000) {
        return formatSalary(min, max, currency, period, false, 'employer', compensationKind(cand));
      }
    }

    const sm = cand.match(singleRegex);
    if (sm && (sm[1] || sm[3] || sm[4] || sm[5])) {
      const currSymbol = sm[1] || '$';
      const currency = sm[4] || (currSymbol.includes('€') ? 'EUR' : currSymbol.includes('£') ? 'GBP' : currSymbol.includes('CAD') ? 'CAD' : 'USD');
      let val = parseFloat(sm[2].replace(/,/g, ''));
      if (sm[3] || (val < 1000 && (sm[0].includes('k') || sm[0].includes('K')))) val *= 1000;
      const period = sm[5] ? (sm[5].startsWith('m') ? 'month' : sm[5].startsWith('h') ? 'hour' : 'year') : (val > 30000 ? 'year' : val > 3000 ? 'month' : 'hour');
      if (val >= 15 && val < 2000000) {
        return formatSalary(val, val, currency, period, false, 'employer', compensationKind(cand));
      }
    }
  }

  return null;
}

const CURRENCY_SYMBOLS = { USD: '$', EUR: '€', GBP: '£', CAD: 'CA$', AUD: 'A$', INR: '₹', SGD: 'S$', JPY: '¥' };
const PERIOD_SUFFIX = { year: '', month: ' /mo', week: ' /wk', day: ' /day', hour: ' /hr' };
const PERIOD_MULTIPLIER = { year: 1, month: 12, week: 52, day: 260, hour: 2080 };

function compactAmount(value) {
  if (value >= 1000) {
    const k = Math.round(value / 100) / 10;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
  }
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

/**
 * Display label for one pay range, e.g. `$135K–$300K USD`, `€110.5K–€181.5K`, `$45–$60 USD /hr`.
 * `$` alone is ambiguous, so USD also carries its code; currencies without a symbol show the code only.
 */
const KIND_SUFFIX = { ote: ' OTE', total: ' total comp' };

export function formatPayLabel(min, max, currency, period, kind = 'base') {
  const sym = CURRENCY_SYMBOLS[currency];
  const amount = (value) => (sym ? `${sym}${compactAmount(value)}` : compactAmount(value));
  const span = min === max ? amount(min) : `${amount(min)}–${amount(max)}`;
  const code = !sym ? ` ${currency}` : currency === 'USD' ? ' USD' : '';
  return `${span}${code}${PERIOD_SUFFIX[period] ?? ''}${KIND_SUFFIX[kind] ?? ''}`;
}

function payRange(min, max, currency, period, location = null, kind = 'base') {
  return { min, max, currency, period, kind, location: typeof location === 'string' && location.trim() ? location.trim() : null, label: formatPayLabel(min, max, currency, period, kind) };
}

/**
 * Employer pay: `min`/`max`/`label` are the full span (first currency listed), `ranges` keeps every
 * stated range with its location/title so the detail page can list each one.
 */
function salaryFromRanges(ranges, isEstimated, source) {
  if (!ranges.length) return null;
  const { currency, period, kind } = ranges[0];
  const same = ranges.filter((range) => range.currency === currency && range.period === period && range.kind === kind);
  const min = Math.min(...same.map((range) => range.min));
  const max = Math.max(...same.map((range) => range.max));
  const multiplier = PERIOD_MULTIPLIER[period] ?? 1;
  return {
    min,
    max,
    annualMin: Math.round(min * multiplier),
    annualMax: Math.round(max * multiplier),
    currency,
    period,
    kind,
    label: (isEstimated ? 'Est. ' : '') + formatPayLabel(min, max, currency, period, kind),
    ranges,
    isEstimated,
    source
  };
}

function formatSalary(min, max, currency, period, isEstimated, source, kind = 'base') {
  return salaryFromRanges([payRange(min, max, currency, period, null, kind)], isEstimated, source);
}

/**
 * Seniority only when the title (or an ATS level field) states it. Unstated → null;
 * never a default such as `mid`.
 * @param {string} role
 * @param {unknown} [atsLevel] free-text level from the ATS (e.g. Greenhouse metadata "Level")
 * @returns {'intern' | 'entry' | 'mid' | 'senior' | 'staff' | 'executive' | null}
 */
export function extractExperienceLevel(role, atsLevel) {
  const r = String(role ?? '').toLowerCase();
  if (/\b(intern|internship|co-op)\b/.test(r)) return 'intern';
  if (/\b(junior|jr\b|graduate|associate|entry)\b/.test(r)) return 'entry';
  if (/\b(staff|principal|distinguished|fellow|architect)\b/.test(r)) return 'staff';
  if (/\b(director|vp\b|head\s+of|chief)\b/.test(r)) return 'executive';
  if (/\b(senior|sr\b|lead)\b/.test(r)) return 'senior';
  if (typeof atsLevel === 'string') {
    const level = atsLevel.toLowerCase();
    if (/\bintern/.test(level)) return 'intern';
    if (/\b(entry|junior|new grad|graduate)\b/.test(level)) return 'entry';
    if (/\b(staff|principal)\b/.test(level)) return 'staff';
    if (/\b(director|vp|head|executive)\b/.test(level)) return 'executive';
    if (/\bsenior\b/.test(level)) return 'senior';
    if (/\bmid\b/.test(level)) return 'mid';
  }
  return null;
}

/**
 * Employment type only when the ATS field or the title states it. Unstated → null;
 * never a default such as `full-time`.
 * @param {string} role
 * @param {unknown} [atsType]
 * @returns {'full-time' | 'part-time' | 'contract' | 'internship' | null}
 */
export function extractEmploymentType(role, atsType) {
  if (typeof atsType === 'string') {
    const norm = atsType.toLowerCase();
    if (norm.includes('contract') || norm.includes('freelance') || norm.includes('temporary')) return 'contract';
    if (norm.includes('intern')) return 'internship';
    if (norm.includes('part')) return 'part-time';
    if (norm.includes('full') || /\bfte\b|\bpermanent\b/.test(norm)) return 'full-time';
  }
  const r = String(role ?? '').toLowerCase();
  if (/\b(intern|internship|co-op)\b/.test(r)) return 'internship';
  if (/\b(contract|contractor|freelance|temp\b)\b/.test(r)) return 'contract';
  if (/\b(part-time|part time)\b/.test(r)) return 'part-time';
  return null;
}

const COUNTRY_ALIASES = {
  usa: 'US', us: 'US', 'u.s.': 'US', 'u.s.a.': 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  uk: 'GB', 'u.k.': 'GB', 'united kingdom': 'GB', 'great britain': 'GB', england: 'GB', scotland: 'GB', wales: 'GB',
  'czech republic': 'CZ', 'south korea': 'KR', korea: 'KR', uae: 'AE', 'the netherlands': 'NL', holland: 'NL', 'hong kong': 'HK',
};
const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '));
// Region-level or private-use codes Intl knows that are not countries (e.g. "European Union" → EU).
const NON_COUNTRY_CODES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ', 'AA', 'XX']);
let countryNameIndex = null;

/** English country name → ISO 3166-1 alpha-2 (built lazily; collection-time only). */
function countryNameMap() {
  if (countryNameIndex) return countryNameIndex;
  countryNameIndex = new Map();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      let name;
      try { name = names.of(code); } catch { continue; }
      if (name && name !== code && !NON_COUNTRY_CODES.has(code)) countryNameIndex.set(name.toLowerCase(), code);
    }
  }
  return countryNameIndex;
}

/**
 * ISO alpha-2 for an explicit country value (code, alias, or English name). Regions
 * such as "EMEA", "NAMER" or "European Union" are not countries → null.
 * @param {unknown} value
 */
export function countryCodeOf(value) {
  if (typeof value !== 'string') return null;
  const clean = value.trim().replace(/\.$/, '');
  if (!clean) return null;
  const lower = clean.toLowerCase();
  if (COUNTRY_ALIASES[lower]) return COUNTRY_ALIASES[lower];
  if (/^[A-Za-z]{2}$/.test(clean)) {
    const code = clean.toUpperCase();
    return countryNameMap().has(countryLabel(code).toLowerCase()) ? code : null;
  }
  return countryNameMap().get(lower) ?? null;
}

const WORKPLACE_WORDS = /\b(remote|hybrid|on-?site|in-?office|distributed|anywhere|worldwide)\b/gi;

/**
 * Parse an ATS free-text location label ("Bangalore, India", "San Francisco, CA",
 * "Remote - US", "London / Berlin") into places with an explicit country. Parts
 * without a recognisable country are dropped, never guessed.
 * @param {string} text
 * @returns {{ locality?: string, region?: string, country: string }[]}
 */
export function placesFromLabel(text) {
  const places = [];
  const parts = String(text ?? '').split(/\s*(?:;|\||\/(?![^(]*\))|\bor\b(?![^(]*\))|·)\s*/i);
  // A parenthetical that is only countries ("Remote (UK)", "(US/Canada)") qualifies the label.
  const qualifiers = parts.map(parentheticalCountries);
  const labelQualifier = [...new Set(qualifiers.flat())];
  parts.forEach((raw, index) => {
    const own = qualifiers[index];
    const part = raw.replace(/\([^)]*\)/g, ' ').replace(WORKPLACE_WORDS, ' ').replace(/^[\s,:–—-]+|[\s,:–—-]+$/g, '').replace(/\s+/g, ' ').trim();
    if (!part) {
      for (const country of own) places.push({ country });
      return;
    }
    const parsed = placeFromPart(part);
    if (parsed) {
      places.push(parsed);
      return;
    }
    // No country of its own: use this part's parenthetical country, else the label's single one.
    const fallback = own.length === 1 ? own : labelQualifier.length === 1 ? labelQualifier : [];
    for (const country of fallback) {
      const segments = part.split(',').map((segment) => segment.trim()).filter(Boolean);
      places.push(own.length === 1 && segments.length === 1 ? { locality: segments[0], country } : { country });
    }
  });
  return places;
}

/** Countries named in a part's parentheses, only when every item there is a country (or a workplace word). */
function parentheticalCountries(part) {
  const codes = [];
  for (const [, inner] of String(part).matchAll(/\(([^)]*)\)/g)) {
    const items = inner.replace(WORKPLACE_WORDS, ' ').split(/\s*(?:,|\/|&|\band\b|\bor\b)\s*/i).map((item) => item.trim()).filter(Boolean);
    const found = items.map(countryCodeOf);
    if (items.length && found.every(Boolean)) codes.push(...found);
  }
  return [...new Set(codes)];
}

// Codes that are both a US state and an ISO country. "Boston, MA" stays US; the country reading
// wins only with explicit evidence: a province-style middle token ("Toronto, ON, CA") or a known city.
const NON_US_CITIES = {
  IN: ['bengaluru', 'bangalore', 'mumbai', 'delhi', 'new delhi', 'hyderabad', 'chennai', 'pune', 'gurgaon', 'gurugram', 'noida', 'kolkata', 'ahmedabad', 'jaipur', 'kochi'],
  CA: ['toronto', 'vancouver', 'montreal', 'montréal', 'ottawa', 'calgary', 'edmonton', 'waterloo', 'kitchener', 'winnipeg', 'halifax', 'quebec city', 'victoria, bc'],
  DE: ['berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln', 'stuttgart', 'düsseldorf'],
  IL: ['tel aviv', 'tel aviv-yafo', 'jerusalem', 'haifa', 'herzliya', 'ramat gan'],
  AR: ['buenos aires', 'córdoba'],
  CO: ['bogotá', 'bogota', 'medellín', 'medellin'],
  ID: ['jakarta', 'bali'],
  MA: ['casablanca', 'rabat'],
  PA: ['panama city'],
};

function placeFromPart(part) {
  const segments = part.split(',').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length < 2) {
    const country = countryCodeOf(part);
    return country ? { country } : null;
  }
  const last = segments[segments.length - 1];
  const upper = last.toUpperCase();
  const country = countryCodeOf(last);
  if (last.length === 2 && US_STATES.has(upper)) {
    const middle = segments.length >= 3 ? segments[segments.length - 2] : '';
    const provinceStyle = /^[A-Za-z]{2}$/.test(middle) && !US_STATES.has(middle.toUpperCase());
    const knownCity = NON_US_CITIES[upper]?.includes(segments[0].toLowerCase());
    if (!(country && (provinceStyle || knownCity))) return { locality: segments[0], region: upper, country: 'US' };
  }
  if (!country) return null;
  const place = { locality: segments[0], country };
  if (segments.length >= 3) place.region = segments[segments.length - 2];
  return place;
}

function addressPlace(postalAddress, fallbackLabel) {
  const country = countryCodeOf(postalAddress?.addressCountry);
  if (!country) return placesFromLabel(fallbackLabel);
  const place = { country };
  const locality = label(postalAddress?.addressLocality);
  const region = label(postalAddress?.addressRegion);
  if (locality) place.locality = locality;
  if (region) place.region = region;
  return [place];
}

function uniquePlaces(places) {
  const seen = new Set();
  const out = [];
  // A bare-country place adds nothing when a more specific place in that country exists.
  const specific = new Set(places.filter((place) => place?.country && (place.locality || place.region)).map((place) => place.country));
  for (const place of places) {
    if (!place?.country) continue;
    if (!place.locality && !place.region && specific.has(place.country)) continue;
    const key = `${place.locality ?? ''}|${place.region ?? ''}|${place.country}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(place);
  }
  return out;
}

const PERIODS = { '1 YEAR': 'year', '1 MONTH': 'month', '1 HOUR': 'hour', 'per-year-salary': 'year', 'per-month-salary': 'month', 'per-hour-wage': 'hour', year: 'year', month: 'month', hour: 'hour' };

function validRange(min, max, currency, period, location, kind = 'base') {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min || max >= 10_000_000) return null;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || !period) return null;
  return payRange(min, max, currency, period, location, kind);
}

function structuredSalary(ranges) {
  const valid = ranges.filter(Boolean);
  return valid.length ? { ...salaryFromRanges(valid, false, 'employer'), basis: 'ats' } : null;
}

const ashbyRange = (item, location) => item?.compensationType === 'Salary' && Number.isFinite(item?.minValue)
  ? validRange(item.minValue, Number.isFinite(item.maxValue) ? item.maxValue : item.minValue, item.currencyCode, PERIODS[item.interval], location)
  : null;

/** Ashby `?includeCompensation=true`: every employer-published base salary tier (title kept as its location). */
export function ashbySalary(entry) {
  const comp = entry?.compensation;
  if (!comp || entry?.shouldDisplayCompensationOnJobPostings === false) return null;
  const tiers = Array.isArray(comp.compensationTiers) ? comp.compensationTiers : [];
  const fromTiers = tiers.flatMap((tier) => (Array.isArray(tier?.components) ? tier.components : []).map((item) => ashbyRange(item, tier?.title)));
  if (fromTiers.some(Boolean)) return structuredSalary(fromTiers);
  const components = Array.isArray(comp.summaryComponents) ? comp.summaryComponents : [];
  return structuredSalary([components.map((item) => ashbyRange(item, null)).find(Boolean)]);
}

/** Greenhouse `?pay_transparency=true`: each pay range with its title (e.g. "US Zone 1"); span in the first currency. */
export function greenhouseSalary(entry) {
  const ranges = Array.isArray(entry?.pay_input_ranges) ? entry.pay_input_ranges.filter((range) => Number.isFinite(range?.min_cents) && Number.isFinite(range?.max_cents) && typeof range?.currency_type === 'string') : [];
  // Greenhouse does not publish an interval: sub-1,000 amounts are hourly wages.
  return structuredSalary(ranges.map((range) => {
    const min = range.min_cents / 100, max = range.max_cents / 100;
    const kind = compensationKind(`${range.title ?? ''} ${range.blurb ?? ''}`);
    return validRange(min, max, range.currency_type.toUpperCase(), max < 1000 ? 'hour' : 'year', range.title, kind);
  }));
}

function leverSalary(entry) {
  const range = entry?.salaryRange;
  if (!range) return null;
  return structuredSalary([validRange(range.min, range.max, typeof range.currency === 'string' ? range.currency.toUpperCase() : null, PERIODS[range.interval])]);
}

function textSalary(text) {
  const salary = parseSalaryDetails(text);
  return salary ? { ...salary, basis: 'text' } : null;
}

/** Employer publish date as ISO, or null when missing, invalid or in the future. */
export function postedAtOf(value, now = Date.now()) {
  if (value == null || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms > now + 86400000 || ms < Date.parse('2000-01-01T00:00:00Z')) return null;
  return new Date(ms).toISOString();
}

function greenhouseMetadata(entry, pattern) {
  const item = Array.isArray(entry?.metadata) ? entry.metadata.find((meta) => pattern.test(String(meta?.name ?? '')) && typeof meta?.value === 'string') : null;
  return item ? item.value : null;
}

export function extractLocation(job, data, now = Date.now()) {
  const target = atsTarget(job.url);
  if (!target || !data || typeof data !== 'object') return null;
  let entry, names = [], cities = [], countries = [], places = [], workplace = 'unknown';
  let salary = null, atsEmploymentType = null, atsLevel = null, department = null, team = null, postedAt = null;

  if (target.kind === 'ashby') {
    entry = Array.isArray(data.jobs) ? data.jobs.find(item => item?.id === target.id) : null;
    if (!entry || entry.isListed === false || !titlesMatch(entry.title, job.role) || canonical(entry.jobUrl) !== canonical(job.url)) return null;
    const locations = [entry, ...(Array.isArray(entry.secondaryLocations) ? entry.secondaryLocations : [])];
    names = locations.map(item => label(item?.location));
    cities = locations.map(item => label(item?.address?.postalAddress?.addressLocality));
    countries = locations.map(item => label(item?.address?.postalAddress?.addressCountry));
    places = locations.flatMap(item => addressPlace(item?.address?.postalAddress, label(item?.location)));
    workplace = ({ Remote: 'remote', Hybrid: 'hybrid', OnSite: 'onsite' })[entry.workplaceType] ?? (entry.isRemote === true ? 'remote' : 'unknown');
    atsEmploymentType = entry.employmentType;
    salary = ashbySalary(entry) || textSalary(entry.descriptionPlain || entry.descriptionHtml);
    department = label(entry.department) || null;
    team = label(entry.team) || null;
    postedAt = postedAtOf(entry.publishedAt, now);
  } else if (target.kind === 'greenhouse') {
    entry = data;
    if (String(entry.id) !== target.id || !titlesMatch(entry.title, job.role)) return null;
    let isGreenhouseHost = false;
    if (entry.absolute_url) {
      try {
        const host = new URL(entry.absolute_url).hostname;
        isGreenhouseHost = host === 'greenhouse.io' || host.endsWith('.greenhouse.io');
      } catch {
        isGreenhouseHost = false;
      }
    }
    if (isGreenhouseHost && canonical(entry.absolute_url).replace('://boards.greenhouse.io/', '://job-boards.greenhouse.io/') !== canonical(job.url).replace('://boards.greenhouse.io/', '://job-boards.greenhouse.io/')) return null;

    names = [label(entry.location?.name)];
    if (Array.isArray(entry.offices)) {
      for (const off of entry.offices) {
        if (off?.name) names.push(label(off.name));
        if (off?.location) names.push(label(off.location));
      }
    }
    const combinedLabels = names.filter(Boolean).join(' ');
    const types = combinedLabels.match(/\b(remote|hybrid|on-site|onsite)\b/gi) ?? [];
    if (types.length === 1 && /^(remote|hybrid|on-site|onsite)(?:$|\s|,|\()/i.test(names[0] || combinedLabels)) {
      workplace = types[0].toLowerCase().replace('on-site', 'onsite');
    } else if (combinedLabels.toLowerCase().includes('remote')) {
      workplace = 'remote';
    } else if (combinedLabels.toLowerCase().includes('hybrid')) {
      workplace = 'hybrid';
    }
    places = names.flatMap(placesFromLabel);
    salary = greenhouseSalary(entry) || textSalary(entry.content);
    atsEmploymentType = greenhouseMetadata(entry, /employment type|job type|commitment/i);
    atsLevel = greenhouseMetadata(entry, /^(level|seniority|job level|career level)$/i);
    department = label(Array.isArray(entry.departments) ? entry.departments[0]?.name : '') || null;
    postedAt = postedAtOf(entry.first_published, now);
  } else if (target.kind === 'lever') {
    entry = data;
    if (entry.id !== target.id || !titlesMatch(entry.text, job.role) || canonical(entry.hostedUrl) !== canonical(job.url)) return null;
    names = Array.isArray(entry.categories?.allLocations) ? entry.categories.allLocations.map(label) : [label(entry.categories?.location)];
    countries = [label(entry.country)];
    // Lever's postings API spells the value `onsite`; accept the hyphenated form too.
    workplace = ({ remote: 'remote', hybrid: 'hybrid', onsite: 'onsite', 'on-site': 'onsite' })[String(entry.workplaceType ?? '').toLowerCase()] ?? 'unknown';
    const leverCountry = countryCodeOf(entry.country);
    places = names.flatMap(placesFromLabel);
    if (!places.length && leverCountry) {
      const only = names.filter(Boolean);
      const locality = only.length === 1 && !countryCodeOf(only[0]) && !only[0].match(WORKPLACE_WORDS) ? only[0] : '';
      places = [locality ? { locality, country: leverCountry } : { country: leverCountry }];
    }
    atsEmploymentType = entry.categories?.commitment;
    salary = leverSalary(entry) || textSalary(entry.additionalPlain || entry.additional || entry.descriptionPlain);
    department = label(entry.categories?.department) || null;
    team = label(entry.categories?.team) || null;
    postedAt = postedAtOf(entry.createdAt, now);
  } else if (target.kind === 'workable') {
    entry = data;
    if (!titlesMatch(entry.title, job.role)) return null;
    if (entry.location) {
      if (entry.location.city) cities.push(label(entry.location.city));
      if (entry.location.country) countries.push(label(entry.location.country));
      if (entry.location.region) names.push(label(entry.location.region));
      if (entry.location.country) names.push(label(entry.location.country));
      const country = countryCodeOf(entry.location.countryCode) || countryCodeOf(entry.location.country);
      if (country) {
        const place = { country };
        if (label(entry.location.city)) place.locality = label(entry.location.city);
        if (label(entry.location.region)) place.region = label(entry.location.region);
        places.push(place);
      }
    }
    if (entry.workplace) {
      workplace = entry.workplace === 'on_site' ? 'onsite' : entry.workplace;
    } else if (entry.remote) {
      workplace = 'remote';
    }
    atsEmploymentType = entry.employment_type ?? entry.type;
    salary = textSalary(entry.salary || entry.description);
    const dept = Array.isArray(entry.department) ? entry.department[0] : entry.department;
    department = label(dept) || null;
    postedAt = postedAtOf(entry.published, now);
  }

  const uniqPlaces = uniquePlaces(places);
  const result = {
    label: unique(names).join(' · '),
    cities: unique(cities),
    countries: unique(countries),
    countryCodes: unique(uniqPlaces.map((place) => place.country)),
    places: uniqPlaces.slice(0, 12),
    workplace,
    salary: salary || null,
    employmentType: extractEmploymentType(job.role, atsEmploymentType),
    experienceLevel: extractExperienceLevel(job.role, atsLevel),
    department,
    team,
    postedAt,
  };

  if (!result.label && !result.cities.length && !result.countries.length && workplace === 'unknown' && !result.salary && !department && !postedAt) return null;
  return result;
}

/**
 * Records older than this are ignored at join time (stale evidence is worse than none).
 * The committed snapshot must be refreshed well inside this window; see
 * `site/scripts/check-job-locations-freshness.mjs` and `.github/workflows/job-locations-refresh.yml`.
 */
export const LOCATION_RECORD_MAX_AGE_MS = 30 * 86400000;

/** One Map per records array so slug pages never re-scan the location index. */
const recordsByJobIdCache = new WeakMap();

/**
 * Slug-keyed / jobId-keyed lookup over the directory location index.
 * Built once per `index.records` array (WeakMap); subsequent gets are O(1).
 * @param {{ records?: unknown[] } | null | undefined} index
 * @returns {Map<string, object>}
 */
export function locationRecordsByJobId(index) {
  const records = index?.records;
  if (!Array.isArray(records)) return new Map();
  let map = recordsByJobIdCache.get(records);
  if (!map) {
    map = new Map(records.map((record) => [record.jobId, record]));
    recordsByJobIdCache.set(records, map);
  }
  return map;
}

/**
 * Attach directory location metadata to a single job via O(1) jobId lookup.
 * Does not iterate `index.records`.
 * @param {object} job
 * @param {{ records?: unknown[] } | null | undefined} index
 * @param {number} [now]
 */
export function attachLocationToJob(job, index, now = Date.now()) {
  const record = locationRecordsByJobId(index).get(job.jobId);
  const age = now - Date.parse(record?.checkedAt);
  const valid = record && record.url === job.url && record.role === job.role && record.company === job.company && age >= 0 && age <= LOCATION_RECORD_MAX_AGE_MS;
  if (!valid) return { ...job, location: null };

  const countries = unique((record.countries || []).map(countryLabel));
  const salary = (record.salary && !record.salary.isEstimated && record.salary.source === 'employer') ? record.salary : null;
  // Only values the source stated: the title-keyword helpers return null when unstated.
  const employmentType = record.employmentType ?? extractEmploymentType(job.role);
  const experienceLevel = record.experienceLevel ?? extractExperienceLevel(job.role);

  return {
    ...job,
    location: {
      ...record,
      countries,
      salary,
      employmentType,
      experienceLevel
    }
  };
}

export function attachLocations(jobs, index, now = Date.now()) {
  // Warm the shared Map once, then attach per job without re-scanning records.
  locationRecordsByJobId(index);
  return jobs.map((job) => attachLocationToJob(job, index, now));
}

