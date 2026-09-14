import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildReview } from '../scripts/job-application.mjs';

const now = new Date('2026-09-14T12:00:00Z');
const applications = (count, submittedAt = '2026-09-14T10:00:00Z') => Array.from({ length: count }, (_, index) => ({
  id: `application-${index}`, company: `Company ${index}`, role: 'Engineer',
  url: `https://example.test/jobs/${index}`, source: 'email', status: 'submitted', submittedAt,
}));
const failure = {
  version: 1, id: 'late-bounce', applicationId: 'application-0', attemptId: 'initial:application-0',
  type: 'delivery-failed', occurredAt: '2026-09-14T11:00:00Z',
  evidenceType: 'final-delivery-failure', evidence: 'Final failure matched to the original application email.',
};

test('late failure does not delay hygiene review after ten more canonical submissions', () => {
  const entries = applications(20);
  const acknowledgements = [{ uniqueSubmissionCount: 10, maturedApplicationCount: 0 }];
  const review = buildReview(entries, [], acknowledgements, now, [failure]);
  assert.equal(review.effectiveSubmissionCount, 19);
  assert.equal(review.submittedSinceLastReview, 10);
  assert.equal(review.reviewDue, true);
  assert.ok(review.reviewReasons.includes('submission-hygiene'));
});

test('late failure does not delay mature review while conversion still uses effective applications', () => {
  const entries = applications(40, '2026-01-01T10:00:00Z');
  const acknowledgements = [{ uniqueSubmissionCount: 40, maturedApplicationCount: 20 }];
  const outcomes = [{ id: 'application-1', status: 'interview', occurredAt: '2026-02-01T10:00:00Z' }];
  const review = buildReview(entries, outcomes, acknowledgements, now, [failure]);
  assert.equal(review.maturedApplications, 39);
  assert.equal(review.conversionRates.interview, 2.6);
  assert.equal(review.reviewDue, true);
  assert.deepEqual(review.reviewReasons, ['outcome-effectiveness']);
});

test('review acknowledgement checkpoints recorded canonical counts after delivery failure', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'review-cadence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entries = applications(20, '2026-01-01T10:00:00Z');
  // A duplicate row must not inflate either checkpoint.
  entries.push({ ...entries[1], id: 'duplicate-row' });
  await writeFile(join(dir, 'applications.ndjson'), entries.map(JSON.stringify).join('\n') + '\n');
  await writeFile(join(dir, 'delivery.ndjson'), JSON.stringify(failure) + '\n');
  await writeFile(join(dir, 'telemetry.json'), JSON.stringify({ enabled: false, disclosed: true }));
  const env = {
    ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: dir,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(dir, 'absent.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
  };
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const ack = JSON.parse(execFileSync(process.execPath, [script, 'ledger', 'review-ack', '--stdin'], {
    env, encoding: 'utf8', input: JSON.stringify({ reviewedAt: now.toISOString() }),
  }));
  assert.equal(ack.uniqueSubmissionCount, 20);
  assert.equal(ack.maturedApplicationCount, 20);
  const stored = JSON.parse((await readFile(join(dir, 'reviews.ndjson'), 'utf8')).trim());
  assert.equal(stored.uniqueSubmissionCount, 20);
  assert.equal(stored.maturedApplicationCount, 20);
});
