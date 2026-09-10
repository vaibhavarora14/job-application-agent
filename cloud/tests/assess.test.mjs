import assert from 'node:assert/strict';
import test from 'node:test';

import { assessQueuedJob } from '../src/assess.mjs';
import { nowIso, openDb } from '../src/db.mjs';
import { queuedCounts } from '../src/queue.mjs';
import { startRound } from '../src/round.mjs';
import { saveProfile } from '../src/skill.mjs';
import { isolatedEnv, sampleExtras, sampleProfile } from './helpers.mjs';

function insertJob(env, overrides = {}) {
  const db = openDb(env);
  const job = {
    id: 'acme-senior-product-aaaaaaaaaa',
    company: 'Example AI',
    role: 'Senior Product Engineer',
    title: 'Senior Product Engineer',
    description: 'Build AI products with TypeScript, React and Python. Remote Canada.',
    url: 'https://job-boards.greenhouse.io/example/jobs/1',
    employer_job_id: 'greenhouse:1',
    application_channel: 'greenhouse',
    discovery_source: 'direct-company',
    locations: JSON.stringify(['Remote', 'Canada']),
    salary_maximum: null,
    salary_currency: null,
    work_mode: 'remote',
    questions_json: null,
    raw_json: null,
    created_at: nowIso(),
    ...overrides,
  };
  db.prepare(`INSERT INTO jobs (id, company, role, title, description, url, employer_job_id, application_channel, discovery_source, locations, salary_maximum, salary_currency, work_mode, questions_json, raw_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    job.id, job.company, job.role, job.title, job.description, job.url, job.employer_job_id,
    job.application_channel, job.discovery_source, job.locations, job.salary_maximum,
    job.salary_currency, job.work_mode, job.questions_json, job.raw_json, job.created_at,
  );
  return job;
}

test('assess scores with the skill and enqueues fill on review', async (t) => {
  const env = await isolatedEnv(t);
  saveProfile(sampleProfile, sampleExtras, '/tmp/resume.pdf', env);
  const job = insertJob(env);
  const round = startRound(10, env);
  const result = await assessQueuedJob(job.id, { roundId: round.id, env });
  assert.equal(result.pendingLlm, undefined);
  assert.ok(['review', 'ask', 'skip', 'exclude'].includes(result.decision));
  const row = openDb(env).prepare('SELECT * FROM assessments WHERE job_id = ?').get(job.id);
  assert.equal(row.provider, 'heuristic');
  if (result.decision === 'review') {
    assert.ok(queuedCounts(env).some((item) => item.type === 'fill'));
  }
});

test('empty must-haves never reach fill: missing skills become ask', async (t) => {
  const env = await isolatedEnv(t);
  saveProfile({ ...sampleProfile, skills: [] }, sampleExtras, '/tmp/resume.pdf', env);
  const job = insertJob(env, {
    id: 'acme-other-bbbbbbbbbb',
    url: 'https://job-boards.greenhouse.io/example/jobs/2',
    description: 'A vague posting about collaboration and culture.',
    title: 'Senior Mystery Role',
    role: 'Senior Mystery Role',
    work_mode: 'unspecified',
  });
  const result = await assessQueuedJob(job.id, { env });
  assert.ok(['ask', 'skip'].includes(result.decision));
  assert.ok(!queuedCounts(env).some((item) => item.type === 'fill' && item.status === 'queued'));
});
