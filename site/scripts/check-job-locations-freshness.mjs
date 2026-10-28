// Fails (exit 1) when site/data/job-locations.json is old enough that the public
// board is about to (or already does) drop every job's location, workplace and pay.
// Usage: node site/scripts/check-job-locations-freshness.mjs [--max-days=21]
// Prints `status=<fresh|refresh|alert|expired|invalid>` for workflow outputs.
import { readFile } from 'node:fs/promises';
import { locationIndexFreshness, LOCATION_INDEX_ALERT_AFTER_DAYS } from '../lib/job-locations-freshness.mjs';

const arg = process.argv.find((value) => value.startsWith('--max-days='));
const maxDays = arg ? Number(arg.split('=')[1]) : LOCATION_INDEX_ALERT_AFTER_DAYS;
const index = JSON.parse(await readFile(new URL('../data/job-locations.json', import.meta.url), 'utf8'));
const result = locationIndexFreshness(index);
console.log(JSON.stringify({ ...result, maxDays, records: index.records?.length ?? 0, snapshotCount: index.snapshotCount ?? null }));
console.log(`status=${result.status}`);
if (result.ageDays === null || result.ageDays > maxDays) {
  console.error(`FAIL: job-locations.json collectedAt=${result.collectedAt} is older than ${maxDays} days (or invalid). Run: node site/scripts/collect-job-locations.mjs`);
  process.exit(1);
}
