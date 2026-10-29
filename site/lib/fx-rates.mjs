/**
 * Monthly reference rates for the /jobs salary filter only (cards always keep the
 * employer's currency). Units of each currency per 1 USD, ECB reference rates
 * published for the first business day of the month (via frankfurter.dev).
 * Refresh monthly; an unknown currency never matches a pay threshold.
 */
export const FX_AS_OF = '2026-10-01';

/** @type {Readonly<Record<string, number>>} */
export const UNITS_PER_USD = Object.freeze({
  USD: 1,
  AUD: 1.4388,
  BRL: 5.1885,
  CAD: 1.4246,
  CHF: 0.83528,
  CNY: 6.7045,
  CZK: 21.649,
  DKK: 6.6169,
  EUR: 0.88511,
  GBP: 0.75565,
  HKD: 7.8472,
  HUF: 325.0,
  IDR: 17946,
  ILS: 3.0762,
  INR: 96.33,
  ISK: 121.26,
  JPY: 157.98,
  KRW: 1361.27,
  MXN: 18.1669,
  MYR: 4.0845,
  NOK: 9.6256,
  NZD: 1.7809,
  PHP: 62.799,
  PLN: 3.871,
  RON: 4.676,
  SEK: 10.0292,
  SGD: 1.2799,
  THB: 33.655,
  TRY: 49.034,
  ZAR: 16.5458,
});

/** Convert an amount to USD; null when the currency has no rate. */
export function toUsd(amount, currency) {
  const rate = UNITS_PER_USD[String(currency ?? '').toUpperCase()];
  if (!rate || !Number.isFinite(amount)) return null;
  return amount / rate;
}
