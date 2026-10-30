import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import locations from '../data/job-locations.json' with { type: 'json' };
import { locationRecordsByJobId } from '../lib/job-locations.mjs';
import * as nodeLookup from '../lib/job-location-lookup.mjs';
import {
  LOCATION_SHARD_COUNT,
  buildLocationShards,
  locationShardOf,
  lookupModuleSource,
  shardModuleSource,
} from '../scripts/job-location-shards.mjs';

// The Worker build swaps lib/job-location-lookup.mjs for the generated sharded module
// (vite.config.ts). Both must return the same record for every jobId.
test('generated sharded lookup returns the same record as the Node module for every jobId', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jaa-shards-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shards = buildLocationShards(locations);
  assert.equal(shards.length, LOCATION_SHARD_COUNT);
  const shardFile = (i) => path.join(dir, `shard-${i}.mjs`);
  await Promise.all(shards.map((shard, i) => writeFile(shardFile(i), shardModuleSource(shard))));
  const fullFile = path.join(dir, 'full.mjs');
  await writeFile(fullFile, `export default ${JSON.stringify(locations)};\n`);
  const lookupFile = path.join(dir, 'lookup.mjs');
  await writeFile(lookupFile, lookupModuleSource(LOCATION_SHARD_COUNT, (i) => pathToFileURL(shardFile(i)).href, pathToFileURL(fullFile).href));
  const sharded = await import(pathToFileURL(lookupFile).href);

  const byId = locationRecordsByJobId(locations);
  assert.ok(byId.size > 100, 'real data set');
  for (const jobId of byId.keys()) {
    const expected = await nodeLookup.locationRecordFor(jobId);
    assert.deepEqual(await sharded.locationRecordFor(jobId), expected, jobId);
  }
  for (const missing of ['community-job-ffffffffffffffff', 'community-job-zz', '', null, undefined, '__proto__', 'constructor']) {
    assert.equal(await sharded.locationRecordFor(missing), await nodeLookup.locationRecordFor(missing), String(missing));
  }
  assert.deepEqual(await sharded.allJobLocations(), await nodeLookup.allJobLocations());

  // Shards stay small: no shard holds more than ~2x its even share.
  const sizes = shards.map((shard) => Object.keys(shard).length);
  assert.equal(sizes.reduce((a, b) => a + b, 0), byId.size);
  assert.ok(Math.max(...sizes) <= Math.ceil((2 * byId.size) / LOCATION_SHARD_COUNT), `max shard ${Math.max(...sizes)}`);
});

test('shard of a jobId comes from its hex tail', () => {
  assert.equal(locationShardOf('community-job-00000000000000ff'), 255 % LOCATION_SHARD_COUNT);
  assert.equal(locationShardOf('community-job-0000000000000020'), 0);
  assert.equal(locationShardOf('community-job-000000000000000G'), -1);
  assert.equal(locationShardOf(undefined), -1);
});

test('generated source escapes characters that could end a string or script', async () => {
  const tricky = { 'community-job-0000000000000001': { note: '</script><b>\u2028\u2029"\\\n' } };
  const source = shardModuleSource(tricky);
  assert.doesNotMatch(source, /[<>\u2028\u2029]/);
  const mod = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  assert.deepEqual(mod.default, tricky);
});
