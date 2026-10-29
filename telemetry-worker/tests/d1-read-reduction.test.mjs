import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPublicStats, recordPublicAggregate, refreshActiveInstallations30d } from '../src/public-stats.mjs';
import { createMemoryD1, hasNodeSqlite } from './d1-mock.mjs';

const sqliteTest = hasNodeSqlite ? test : test.skip;
const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));

async function applyMigrations(db) {
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    await db.exec(sql);
  }
}

function seedJobs(db, count = 200) {
  const insertJob = db.database.prepare(`
    INSERT INTO community_jobs (
      job_id, canonical_url, company, role, application_channel, discovery_source, provider_url,
      publication_status, review_status, published_at, reviewed_at, first_seen_at, last_seen_at,
      first_skill_version, last_skill_version, liveness_status, last_checked_at, closed_at, contribution_count
    ) VALUES (?, ?, 'Co', ?, 'url', NULL, ?, 'published', 'maintainer-reviewed', ?, ?, ?, ?, '3.7.0', '3.7.0', ?, ?, NULL, ?)
  `);
  const insertContrib = db.database.prepare(`
    INSERT INTO community_job_contributions (job_id, contributor_hash, first_seen_at, last_seen_at, skill_version)
    VALUES (?, ?, ?, ?, '3.7.0')
  `);
  for (let index = 0; index < count; index++) {
    const jobId = `job-${String(index).padStart(5, '0')}`;
    const seen = `2026-09-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`;
    const open = index % 3 === 0;
    const checked = index % 5 === 0 ? null : `2026-10-13T${String(index % 24).padStart(2, '0')}:00:00.000Z`;
    const status = open ? 'open' : 'closed';
    const contribs = 1 + (index % 3);
    insertJob.run(
      jobId,
      `https://example.com/${jobId}`,
      `Role ${index}`,
      `https://example.com/${jobId}`,
      seen,
      seen,
      seen,
      seen,
      status,
      checked,
      contribs,
    );
    for (let contrib = 0; contrib < contribs; contrib++) {
      insertContrib.run(jobId, `hash-${index}-${contrib}`, seen, seen);
    }
  }
}

sqliteTest('liveness due + live-open query plans use dedicated indexes without TEMP sorts', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  seedJobs(db, 300);

  const duePlan = db.explain(`
    SELECT jobs.job_id, jobs.contribution_count
    FROM community_jobs AS jobs
    WHERE jobs.publication_status = 'published'
      AND jobs.review_status = 'maintainer-reviewed'
    ORDER BY jobs.last_checked_at ASC, jobs.job_id ASC
    LIMIT 51
  `);
  const dueText = JSON.stringify(duePlan);
  assert.match(dueText, /idx_community_jobs_liveness_due/);
  assert.doesNotMatch(dueText, /TEMP B-TREE/);
  assert.doesNotMatch(dueText, /CORRELATED/);

  const livePlan = db.explain(`
    SELECT jobs.job_id, jobs.contribution_count
    FROM community_jobs AS jobs
    WHERE jobs.publication_status = 'published'
      AND jobs.review_status = 'maintainer-reviewed'
      AND jobs.liveness_status = 'open'
    ORDER BY jobs.last_seen_at DESC, jobs.job_id DESC
    LIMIT 101
  `);
  const liveText = JSON.stringify(livePlan);
  assert.match(liveText, /idx_community_jobs_live/);
  assert.doesNotMatch(liveText, /COALESCE/);
  assert.doesNotMatch(liveText, /CORRELATED/);

  const newestPlan = db.explain('SELECT newest_last_checked_at FROM public_liveness_meta WHERE id = 1');
  assert.match(JSON.stringify(newestPlan), /public_liveness_meta/);

  const lifetimePlan = db.explain(`
    SELECT installations, active_installations_30d, jobs_assessed, applications_submitted, interviews, offers
    FROM public_stats_lifetime WHERE id = 1
  `);
  assert.match(JSON.stringify(lifetimePlan), /public_stats_lifetime/);
});

sqliteTest('public lifetime summary matches prior aggregate values and increments identically', async () => {
  const db = createMemoryD1();
  await applyMigrations(db);
  const secret = 'test-signing-secret-with-sufficient-length';
  const now = new Date('2026-10-14T12:00:00.000Z');

  await recordPublicAggregate(db, {
    installationId: '11111111-1111-4111-8111-111111111111',
    event: 'installation_started',
    properties: {},
  }, secret, now);
  await recordPublicAggregate(db, {
    installationId: '11111111-1111-4111-8111-111111111111',
    event: 'job_assessed',
    properties: {},
  }, secret, now);
  await recordPublicAggregate(db, {
    installationId: '11111111-1111-4111-8111-111111111111',
    event: 'application_submitted',
    properties: { ats: 'ashby' },
  }, secret, now);
  await recordPublicAggregate(db, {
    installationId: '11111111-1111-4111-8111-111111111111',
    event: 'outcome_recorded',
    properties: { outcome: 'interview' },
  }, secret, now);
  await recordPublicAggregate(db, {
    installationId: '22222222-2222-4222-8222-222222222222',
    event: 'installation_started',
    properties: {},
  }, secret, now);

  await refreshActiveInstallations30d(db, now);
  const stats = await buildPublicStats(db, now);
  // Only the installation with real activity is counted; installation_started alone is not.
  assert.equal(stats.metrics.installations, 1);
  assert.equal(stats.metrics.jobsAssessed, 1);
  assert.equal(stats.metrics.applicationsSubmitted, 1);
  assert.equal('interviews' in stats.metrics, false);
  assert.equal(stats.metrics.offers, 0);
  assert.equal(stats.metrics.activeInstallations30d, 1);

  const dailyJobs = db.database.prepare(
    `SELECT COALESCE(SUM(count), 0) AS total FROM public_daily_metrics WHERE metric = 'jobs_assessed'`,
  ).get().total;
  const dailyApps = db.database.prepare(
    `SELECT COALESCE(SUM(count), 0) AS total FROM public_daily_metrics WHERE metric = 'applications_submitted'`,
  ).get().total;
  const dailyInterviews = db.database.prepare(
    `SELECT COALESCE(SUM(count), 0) AS total FROM public_daily_metrics WHERE metric = 'interviews'`,
  ).get().total;
  const installCount = db.database.prepare('SELECT COUNT(*) AS total FROM public_installations WHERE uncounted = 0').get().total;
  const lifetimeInterviews = db.database.prepare('SELECT interviews FROM public_stats_lifetime WHERE id = 1').get().interviews;
  assert.equal(stats.metrics.jobsAssessed, dailyJobs);
  assert.equal(stats.metrics.applicationsSubmitted, dailyApps);
  assert.equal(lifetimeInterviews, dailyInterviews); // still collected internally, never public
  assert.equal(stats.metrics.installations, installCount);
});

sqliteTest('migration backfill keeps lifetime totals equal to table aggregates', async () => {
  const db = createMemoryD1();
  // Apply through 0004 only, seed, then 0005 to verify backfill identity.
  const files = (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    if (file.startsWith('0005')) break;
    await db.exec(await readFile(join(migrationsDir, file), 'utf8'));
  }
  db.database.prepare(`
    INSERT INTO public_installations (installation_hash, installed_at, last_active_at)
    VALUES ('a', '2026-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
           ('b', '2026-01-01T00:00:00.000Z', NULL)
  `).run();
  db.database.prepare(`
    INSERT INTO public_daily_metrics (day, metric, segment, count) VALUES
      ('2026-10-01', 'jobs_assessed', '', 10),
      ('2026-10-01', 'applications_submitted', '', 4),
      ('2026-10-01', 'interviews', '', 2),
      ('2026-10-01', 'offers', '', 1)
  `).run();

  await db.exec(await readFile(join(migrationsDir, '0005_d1_read_reduction.sql'), 'utf8'));
  const row = db.database.prepare('SELECT * FROM public_stats_lifetime WHERE id = 1').get();
  assert.equal(row.installations, 2);
  assert.equal(row.jobs_assessed, 10);
  assert.equal(row.applications_submitted, 4);
  assert.equal(row.interviews, 2);
  assert.equal(row.offers, 1);
  assert.equal(row.active_installations_30d, 1);
});
