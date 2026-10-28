import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';
import locations from '../data/job-locations.json' with { type: 'json' };
import { fixtureLiveJobs } from '../lib/jobs-board-data.mjs';
import { attachLocationToJob, attachLocations, locationRecordsByJobId } from '../lib/job-locations.mjs';
import { loadJobPageBySlug } from '../lib/job-page-data.mjs';
import { findJobBySlug, loadJobsBoard } from '../lib/load-jobs-board.mjs';
import { jobSlug, isListedOpenJob, similarOpenRoles, jobPostingJsonLd } from '../lib/live-jobs.mjs';

const now = Date.parse('2026-10-13T12:00:00.000Z');

/** Instrument an index so any full-records scan is visible to tests. */
function spyingLocationIndex(records) {
  let scans = 0;
  const scanProps = new Set([
    'map',
    'forEach',
    'filter',
    'reduce',
    'entries',
    'values',
    'keys',
    Symbol.iterator,
  ]);
  // Proxy keeps Array.isArray true so locationRecordsByJobId accepts it.
  const view = new Proxy(records, {
    get(target, prop, receiver) {
      if (scanProps.has(prop)) scans += 1;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    index: { collectedAt: locations.collectedAt, records: view },
    scans: () => scans,
  };
}

function largeBoard(size = 640) {
  const base = fixtureLiveJobs(now);
  const jobs = [];
  for (let i = 0; i < size; i++) {
    const template = base[i % base.length];
    const hex = i.toString(16).padStart(16, '0');
    const jobId = `community-job-${hex}`;
    const closed = i % 20 === 0;
    jobs.push({
      jobId,
      url: template.url,
      company: `${template.company} ${i % 50}`,
      role: `${template.role} ${i % 30}`,
      applicationChannel: template.applicationChannel,
      discoverySource: template.discoverySource,
      providerUrl: template.providerUrl,
      firstSeenAt: template.firstSeenAt,
      lastSeenAt: template.lastSeenAt,
      contributionCount: template.contributionCount,
      livenessStatus: closed ? 'closed' : 'open',
      lastCheckedAt: new Date(now - (i % 2) * 86400000).toISOString(),
      closedAt: closed ? new Date(now - 86400000).toISOString() : null,
    });
  }
  return jobs;
}

test('loadJobPageBySlug matches loadJobsBoard + findJobBySlug page payload for fixtures', async () => {
  const board = await loadJobsBoard({ useFixtures: true, now });
  for (const listed of board.all) {
    if (listed.livenessStatus !== 'closed' && !isListedOpenJob(listed, board.now)) continue;
    const page = await loadJobPageBySlug(listed.slug, { useFixtures: true, now });
    assert.ok(page, listed.slug);
    assert.equal(page.job.jobId, listed.jobId);
    assert.equal(page.job.slug, listed.slug);
    assert.deepEqual(page.job.location, listed.location);
    const expectedSimilar =
      listed.livenessStatus === 'closed' ? similarOpenRoles(listed, board.open, 3) : [];
    assert.deepEqual(
      page.similar.map((job) => job.jobId),
      expectedSimilar.map((job) => job.jobId),
      listed.slug,
    );
    // JSON-LD must stay byte-stable for the same job object shape.
    assert.deepEqual(jobPostingJsonLd(page.job), jobPostingJsonLd(listed));
  }
});

test('open slug render does not scan the full location records index', async () => {
  const jobs = largeBoard(640);
  const open = jobs.find((job) => job.livenessStatus === 'open');
  assert.ok(open);
  const slug = jobSlug(open);
  const spy = spyingLocationIndex(locations.records);

  // One Map build from records is shared for the isolate; warm it here so the
  // slug render under test only does Map.get lookups.
  locationRecordsByJobId(spy.index);
  assert.equal(spy.scans(), 1, 'warm builds the jobId Map once');

  const page = await loadJobPageBySlug(slug, {
    loadLive: async () => jobs,
    now,
    locationIndex: spy.index,
  });
  assert.ok(page);
  assert.equal(page.job.jobId, open.jobId);
  assert.equal(page.similar.length, 0);
  assert.equal(spy.scans(), 1, 'open slug must not re-scan location records');
});

test('attachLocationToJob is O(1) lookup and matches attachLocations for one job', () => {
  const record = locations.records[0];
  assert.ok(record);
  const job = {
    jobId: record.jobId,
    url: record.url,
    company: record.company,
    role: record.role,
    slug: 'probe',
  };
  const spy = spyingLocationIndex(locations.records);
  // First call builds the Map (one scan of the spy view).
  const first = attachLocationToJob(job, spy.index, now);
  const scansAfterBuild = spy.scans();
  assert.equal(scansAfterBuild, 1);
  // Later calls reuse the WeakMap and must not scan again.
  const second = attachLocationToJob(job, spy.index, now);
  assert.equal(spy.scans(), scansAfterBuild);
  assert.deepEqual(first, second);
  assert.deepEqual(first, attachLocations([job], locations, now)[0]);
});

test('slug page path timing stays well under full-board location attach', async () => {
  // Fresh lastCheckedAt so the production memo path (no pinned `now`) keeps jobs listed.
  const jobs = largeBoard(640).map((job) => ({
    ...job,
    lastCheckedAt: new Date().toISOString(),
    closedAt: job.livenessStatus === 'closed' ? new Date().toISOString() : null,
  }));
  const open = jobs.find((job) => job.livenessStatus === 'open' && jobs.indexOf(job) > 100);
  const slug = jobSlug(open);
  const loadLive = async () => jobs;

  function fullBoardPath() {
    const withSlugs = jobs.map((job) => ({ ...job, slug: job.slug ?? jobSlug(job) }));
    const enriched = attachLocations(withSlugs, locations, Date.now());
    const found = findJobBySlug(enriched, slug);
    const openJobs = enriched.filter((job) => isListedOpenJob(job, Date.now()));
    return { found, openJobs };
  }

  async function slugPath() {
    // No pinned `now` / `locationIndex` → per-raw-array slug index + page map memo.
    return loadJobPageBySlug(slug, { loadLive });
  }

  // Warm both paths (includes first slug-index build + page materialisation).
  fullBoardPath();
  await slugPath();

  const fullSamples = [];
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now();
    fullBoardPath();
    fullSamples.push(performance.now() - t0);
  }
  const slugSamples = [];
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now();
    await slugPath();
    slugSamples.push(performance.now() - t0);
  }
  const mean = (arr) => arr.reduce((sum, value) => sum + value, 0) / arr.length;
  const fullMean = mean(fullSamples);
  const slugMean = mean(slugSamples);
  assert.ok(
    slugMean < fullMean,
    `expected slug path (${slugMean.toFixed(3)}ms) < full board path (${fullMean.toFixed(3)}ms)`,
  );
  // After memo warm, slug resolve is a Map.get — keep a tight local budget.
  assert.ok(slugMean < 0.5, `slug path mean ${slugMean.toFixed(3)}ms exceeded 0.5ms budget`);
  console.error(
    JSON.stringify({
      benchmark: 'job-page-data',
      jobs: jobs.length,
      fullBoardAttachMeanMs: Number(fullMean.toFixed(3)),
      slugPageMeanMs: Number(slugMean.toFixed(3)),
      speedup: Number((fullMean / Math.max(slugMean, 0.0001)).toFixed(1)),
    }),
  );
});
