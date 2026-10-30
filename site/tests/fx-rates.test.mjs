import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { FX_AS_OF, UNITS_PER_USD } from '../lib/fx-rates.mjs';
import {
  FX_MAX_AGE_DAYS,
  fetchFirstBusinessDayRates,
  fxTableAgeDays,
  renderFxRatesSource,
  selectRates,
  tableCurrencies,
} from '../lib/fx-rates-refresh.mjs';

// Normalise CRLF so the line-level assertions below hold on Windows checkouts (autocrlf);
// the CRLF test at the end covers the refresher on a CRLF file directly.
const source = (await readFile(new URL('../lib/fx-rates.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

test(`/jobs pay-filter FX table is no older than ${FX_MAX_AGE_DAYS} days (refresh: node site/scripts/refresh-fx-rates.mjs)`, () => {
  const ageDays = fxTableAgeDays(FX_AS_OF);
  assert.notEqual(ageDays, null, 'FX_AS_OF must be YYYY-MM-DD');
  assert.ok(ageDays >= 0, 'FX_AS_OF must not be in the future');
  assert.ok(ageDays <= FX_MAX_AGE_DAYS, `FX_AS_OF=${FX_AS_OF} is ${ageDays} days old; run node site/scripts/refresh-fx-rates.mjs`);
});

test('fxTableAgeDays counts whole UTC days and rejects non-dates', () => {
  assert.equal(fxTableAgeDays('2026-10-01', new Date('2026-10-01T23:59:00Z')), 0);
  assert.equal(fxTableAgeDays('2026-10-01', new Date('2026-11-15T00:00:00Z')), 45);
  assert.equal(fxTableAgeDays('2026-10-01', new Date('2026-11-16T00:00:00Z')), 46);
  assert.equal(fxTableAgeDays('Oct 1', new Date()), null);
  assert.equal(fxTableAgeDays('2026-02-31', new Date('2026-03-10T00:00:00Z')), null, 'impossible dates must not roll over');
  assert.equal(fxTableAgeDays('2026-13-01', new Date()), null);
  assert.equal(fxTableAgeDays('2028-02-29', new Date('2028-03-01T00:00:00Z')), 1, 'leap day is real');
  assert.equal(fxTableAgeDays(undefined, new Date()), null);
});

test('first business day lookup skips weekend answers that fall back to the previous month', async () => {
  const asked = [];
  // 2026-11-01 is a Sunday: frankfurter answers with Friday 2026-10-30; Monday 2026-11-02 is the business day.
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const date = String(url).match(/(\d{4}-\d{2}-\d{2})/)[1];
    const answered = date === '2026-11-01' ? '2026-10-30' : date;
    return new Response(JSON.stringify({ amount: 1, base: 'USD', date: answered, rates: { EUR: 0.9, INR: 95.5 } }));
  };
  const result = await fetchFirstBusinessDayRates('2026-11', { fetchImpl });
  assert.equal(result.date, '2026-11-02');
  assert.deepEqual(result.rates, { EUR: 0.9, INR: 95.5 });
  assert.deepEqual(asked, ['https://api.frankfurter.dev/v1/2026-11-01?base=USD', 'https://api.frankfurter.dev/v1/2026-11-02?base=USD']);
  await assert.rejects(fetchFirstBusinessDayRates('2026-11', { fetchImpl: async () => new Response('', { status: 500 }) }), /HTTP 500/);
  await assert.rejects(fetchFirstBusinessDayRates('Nov', { fetchImpl }), /YYYY-MM/);
});

test('refresh keeps the same currencies in order and fails if the source drops one', () => {
  const currencies = tableCurrencies(source);
  assert.deepEqual(currencies, Object.keys(UNITS_PER_USD));
  assert.equal(currencies[0], 'USD');
  const rates = Object.fromEntries(currencies.filter((code) => code !== 'USD').map((code) => [code, UNITS_PER_USD[code] * 1.01]));
  assert.deepEqual(Object.keys(selectRates(currencies, rates)), currencies);
  const missingInr = Object.fromEntries(Object.entries(rates).filter(([code]) => code !== 'INR'));
  assert.throws(() => selectRates(currencies, missingInr), /INR/);
  assert.throws(() => selectRates(currencies, { ...rates, EUR: 0 }), /EUR/);
});

test('rendering the current table back is byte-identical, and a refresh only changes FX_AS_OF and values', async () => {
  const currencies = tableCurrencies(source);
  assert.equal(renderFxRatesSource(source, FX_AS_OF, selectRates(currencies, UNITS_PER_USD)), source);

  const refreshedRates = selectRates(currencies, { ...UNITS_PER_USD, EUR: 0.89823, INR: 95.22 });
  const next = renderFxRatesSource(source, '2026-11-02', refreshedRates);
  assert.match(next, /export const FX_AS_OF = '2026-11-02';/);
  assert.ok(next.includes('\n  EUR: 0.89823,\n'));
  assert.ok(next.includes('\n  INR: 95.22,\n'));
  assert.match(next, /export function toUsd\(amount, currency\)/);
  assert.throws(() => renderFxRatesSource(source, '2026-02-31', refreshedRates), /real YYYY-MM-DD/);
  const changed = next.split('\n').filter((line, index) => line !== source.split('\n')[index]);
  assert.deepEqual(changed, ["export const FX_AS_OF = '2026-11-02';", '  EUR: 0.89823,', '  INR: 95.22,']);
  const refreshed = await import(`data:text/javascript,${encodeURIComponent(next)}`);
  assert.equal(refreshed.FX_AS_OF, '2026-11-02');
  assert.equal(refreshed.toUsd(95.22, 'INR'), 1);
});

test('the refresher reads and rewrites a CRLF checkout of fx-rates.mjs, keeping CRLF', () => {
  const crlf = source.replace(/\n/g, '\r\n');
  const currencies = tableCurrencies(crlf);
  assert.deepEqual(currencies, Object.keys(UNITS_PER_USD));
  assert.equal(renderFxRatesSource(crlf, FX_AS_OF, selectRates(currencies, UNITS_PER_USD)), crlf);
  const next = renderFxRatesSource(crlf, '2026-11-02', selectRates(currencies, { ...UNITS_PER_USD, EUR: 0.89823 }));
  assert.ok(next.includes('\r\n  EUR: 0.89823,\r\n'));
  assert.equal(next.replace(/\r\n/g, '').includes('\n'), false);
});
