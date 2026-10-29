// Refresh site/lib/fx-rates.mjs (the /jobs minimum-pay filter table) from ECB reference
// rates for the first business day of the month, via frankfurter.dev (#196).
// Usage: node site/scripts/refresh-fx-rates.mjs [--month=YYYY-MM] [--check]
//   --check  exit 1 when FX_AS_OF is older than FX_MAX_AGE_DAYS (no network, no write).
// Run at the start of each month and commit the diff; cards keep the employer's currency.
import { readFile, writeFile } from 'node:fs/promises';
import { FX_AS_OF } from '../lib/fx-rates.mjs';
import {
  FX_MAX_AGE_DAYS,
  currentMonth,
  fetchFirstBusinessDayRates,
  fxTableAgeDays,
  renderFxRatesSource,
  selectRates,
  tableCurrencies,
} from '../lib/fx-rates-refresh.mjs';

const file = new URL('../lib/fx-rates.mjs', import.meta.url);
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1];

if (process.argv.includes('--check')) {
  const ageDays = fxTableAgeDays(FX_AS_OF);
  console.log(JSON.stringify({ FX_AS_OF, ageDays, maxDays: FX_MAX_AGE_DAYS }));
  if (ageDays === null || ageDays > FX_MAX_AGE_DAYS) {
    console.error(`FAIL: FX_AS_OF=${FX_AS_OF} is older than ${FX_MAX_AGE_DAYS} days. Run: node site/scripts/refresh-fx-rates.mjs`);
    process.exit(1);
  }
  process.exit(0);
}

const month = arg('month') ?? currentMonth();
const source = await readFile(file, 'utf8');
const { date, rates } = await fetchFirstBusinessDayRates(month);
const next = renderFxRatesSource(source, date, selectRates(tableCurrencies(source), rates));
if (next === source) {
  console.log(`fx-rates.mjs already at ${date}; no change.`);
} else {
  await writeFile(file, next);
  console.log(`fx-rates.mjs refreshed to ECB reference rates of ${date} (${tableCurrencies(next).length} currencies).`);
}
