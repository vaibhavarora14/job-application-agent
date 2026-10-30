/**
 * Helpers for the monthly /jobs pay-filter FX refresh (#196).
 * Source: ECB reference rates via frankfurter.dev, first business day of the month.
 * Used by scripts/refresh-fx-rates.mjs and the staleness test; nothing here runs on the Worker.
 */

/** A table older than this is stale (monthly refresh plus two weeks of slack). */
export const FX_MAX_AGE_DAYS = 45;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whole days between FX_AS_OF and `now`; null when FX_AS_OF is not an ISO date. */
export function fxTableAgeDays(asOf, now = new Date()) {
  if (typeof asOf !== 'string' || !ISO_DATE.test(asOf)) return null;
  const asOfMs = Date.parse(`${asOf}T00:00:00Z`);
  // Date.parse rolls impossible dates over (2026-02-31 → 2026-03-03); reject them instead.
  if (!Number.isFinite(asOfMs) || new Date(asOfMs).toISOString().slice(0, 10) !== asOf) return null;
  return Math.floor((now.getTime() - asOfMs) / DAY_MS);
}

/** `YYYY-MM` for `now` (UTC). */
export function currentMonth(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

/**
 * Fetch USD-based ECB rates for the first business day of `month` (`YYYY-MM`).
 * frankfurter.dev answers a weekend/holiday with the previous business day, so walk
 * days 1..7 until the answered date is the requested one.
 */
export async function fetchFirstBusinessDayRates(month, { fetchImpl = fetch, baseUrl = 'https://api.frankfurter.dev/v1' } = {}) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error(`month must be YYYY-MM, got ${month}`);
  for (let day = 1; day <= 7; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const response = await fetchImpl(`${baseUrl}/${date}?base=USD`);
    if (!response.ok) throw new Error(`frankfurter.dev ${date}: HTTP ${response.status}`);
    const body = await response.json();
    if (body?.base !== 'USD' || !body?.rates || typeof body.rates !== 'object') throw new Error(`frankfurter.dev ${date}: unexpected body`);
    if (body.date === date) return { date, rates: body.rates };
  }
  throw new Error(`frankfurter.dev: no business day found in the first week of ${month}`);
}

/**
 * Pick the currencies the table already carries (same set, same order); fail when the
 * source drops one rather than silently losing a currency from the pay filter.
 */
export function selectRates(currencies, rates) {
  const out = {};
  for (const code of currencies) {
    if (code === 'USD') { out.USD = 1; continue; }
    const value = rates[code];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`source has no usable rate for ${code}`);
    out[code] = value;
  }
  return out;
}

/** Rewrite FX_AS_OF and the UNITS_PER_USD body in the fx-rates.mjs source, keeping everything else. */
export function renderFxRatesSource(source, date, rates) {
  if (fxTableAgeDays(date) === null) throw new Error(`date must be a real YYYY-MM-DD date, got ${date}`);
  const asOf = /export const FX_AS_OF = '\d{4}-\d{2}-\d{2}';/;
  // Windows checkouts may use CRLF; match either and keep the file's own line ending.
  const table = /(export const UNITS_PER_USD = Object\.freeze\(\{\r?\n)([\s\S]*?)(\r?\n\}\);)/;
  if (!asOf.test(source) || !table.test(source)) throw new Error('fx-rates.mjs layout changed; update renderFxRatesSource');
  const body = Object.entries(rates).map(([code, value]) => `  ${code}: ${formatRate(value)},`).join(source.includes('\r\n') ? '\r\n' : '\n');
  return source.replace(asOf, `export const FX_AS_OF = '${date}';`).replace(table, `$1${body}$3`);
}

/** Currency codes in table order, read from the fx-rates.mjs source. */
export function tableCurrencies(source) {
  const match = source.match(/export const UNITS_PER_USD = Object\.freeze\(\{\r?\n([\s\S]*?)\r?\n\}\);/);
  if (!match) throw new Error('UNITS_PER_USD table not found');
  return [...match[1].matchAll(/^\s*([A-Z]{3}):/gm)].map((m) => m[1]);
}

function formatRate(value) {
  // Keep the ECB precision as published; integers stay integers except where the table used `.0`.
  return Number.isInteger(value) && value < 1000 && value !== 1 ? value.toFixed(1) : String(value);
}
