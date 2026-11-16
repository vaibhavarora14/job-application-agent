/**
 * Monthly reference rates for the /jobs salary filter only (cards always keep the
 * employer's currency). Units of each currency per 1 USD, ECB reference rates
 * published for the first business day of the month (via frankfurter.dev).
 * Refresh monthly with `npm --prefix site run fx:refresh` (a site test fails once FX_AS_OF is
 * older than 45 days); an unknown currency never matches a pay threshold.
 */
export const FX_AS_OF = '2026-11-02';

/** @type {Readonly<Record<string, number>>} */
export const UNITS_PER_USD = Object.freeze({
  USD: 1,
  AUD: 1.4269,
  BRL: 5.4378,
  CAD: 1.3974,
  CHF: 0.81963,
  CNY: 6.6483,
  CZK: 21.711,
  DKK: 6.6634,
  EUR: 0.89158,
  GBP: 0.74519,
  HKD: 7.8461,
  HUF: 324.98,
  IDR: 18136,
  ILS: 3.1393,
  INR: 94.91,
  ISK: 121.43,
  JPY: 157.9,
  KRW: 1342.9,
  MXN: 18.7197,
  MYR: 4.0705,
  NOK: 9.2524,
  NZD: 1.7773,
  PHP: 63.547,
  PLN: 3.9395,
  RON: 4.7615,
  SEK: 9.7606,
  SGD: 1.2789,
  THB: 33.76,
  TRY: 49.968,
  ZAR: 16.6386,
});

/** Convert an amount to USD; null when the currency has no rate. */
export function toUsd(amount, currency) {
  const rate = UNITS_PER_USD[String(currency ?? '').toUpperCase()];
  if (!rate || !Number.isFinite(amount)) return null;
  return amount / rate;
}
