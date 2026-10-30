// Build-time split of data/job-locations.json for the Worker (see vite.config.ts,
// jobLocationShards). A cold /jobs/<slug> render then evaluates one small shard
// (~1/32 of the records) instead of the whole ~700 KB file.

export const LOCATION_SHARD_COUNT = 32;

/** Shard for a jobId (`community-job-<16 hex>`), or -1 when the id has no hex tail. */
export function locationShardOf(jobId, count = LOCATION_SHARD_COUNT) {
  const tail = String(jobId ?? '').slice(-2);
  if (!/^[0-9a-f]{2}$/.test(tail)) return -1;
  return Number.parseInt(tail, 16) % count;
}

/**
 * Records keyed by jobId, split into `count` shards. Later duplicates win, as in
 * locationRecordsByJobId's Map.
 * @param {{ records?: unknown[] }} data
 */
export function buildLocationShards(data, count = LOCATION_SHARD_COUNT) {
  const shards = Array.from({ length: count }, () => ({}));
  for (const record of Array.isArray(data?.records) ? data.records : []) {
    const shard = locationShardOf(record?.jobId, count);
    if (shard >= 0) shards[shard][record.jobId] = record;
  }
  return shards;
}

/** One shard module: `export default JSON.parse("…")` (cheaper than an object literal). */
export function shardModuleSource(shard) {
  return `export default JSON.parse(${JSON.stringify(JSON.stringify(shard))});\n`;
}

/**
 * Replacement for lib/job-location-lookup.mjs with the same exports.
 * @param {number} count
 * @param {(index: number) => string} shardSpecifier import specifier of shard i
 * @param {string} fullSpecifier import specifier of the whole JSON file
 */
export function lookupModuleSource(count, shardSpecifier, fullSpecifier) {
  const loaders = Array.from({ length: count }, (_, i) => `  () => import(${JSON.stringify(shardSpecifier(i))}),`).join('\n');
  return `const shards = [
${loaders}
];
function shardOf(jobId) {
  const tail = String(jobId ?? '').slice(-2);
  if (!/^[0-9a-f]{2}$/.test(tail)) return -1;
  return Number.parseInt(tail, 16) % ${count};
}
export async function locationRecordFor(jobId) {
  const shard = shardOf(jobId);
  if (shard < 0) return undefined;
  const records = (await shards[shard]()).default;
  return Object.prototype.hasOwnProperty.call(records, jobId) ? records[jobId] : undefined;
}
export async function allJobLocations() {
  return (await import(${JSON.stringify(fullSpecifier)})).default;
}
`;
}
