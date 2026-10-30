// #217: a job without posting text is answered as not scored, never counted as invalid input.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { missingDescriptionResult } from '../scripts/job-application.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

const target = {
  name: 'Test Candidate', email: 'candidate@example.com', phone: '+1 555 0100', location: 'Toronto, Canada',
  workAuthorization: 'Canada', roleFamilies: ['product-engineering'], seniority: ['senior', 'staff'],
  skills: ['TypeScript'], targetLocations: ['Canada', 'Remote'], workModes: ['remote'],
  submissionMode: 'routine-auto', yearsExperience: 10, autoSubmitMinScore: 80, manualReviewMinScore: 70, minMustHaveCoverage: 70,
};

function job(overrides = {}) {
  return {
    title: 'Principal Product Engineer', company: 'Skip Co', description: 'Build products with TypeScript.',
    source: 'greenhouse', eligibility: 'eligible', postingStatus: 'active', roleFamily: 'product-engineering',
    seniority: 'principal', workMode: 'remote', remote: true, locations: ['Remote'],
    url: 'https://boards.greenhouse.io/skipco/jobs/101',
    mustHaves: [{ requirement: 'TypeScript', status: 'met', evidence: 'Resume skills' }],
    target, ...overrides,
  };
}

async function fixture(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `jaa-guards-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }));
  return {
    directory,
    env: {
      ...process.env,
      JOB_APPLICATION_AGENT_STATE_DIR: directory,
      JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'cloud-config.json'),
      JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
      JOB_APPLICATION_AGENT_NO_BROWSER: '1',
      JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
    },
  };
}

function run(env, args, input) {
  return spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', ...(input === undefined ? {} : { input: JSON.stringify(input) }) });
}
function ok(env, args, input) {
  const result = run(env, args, input);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}


test('missingDescriptionResult flags missing or blank posting text only', () => {
  assert.equal(missingDescriptionResult({ description: 'Build things.' }), null);
  for (const description of [undefined, null, '', '   \n ']) {
    assert.equal(missingDescriptionResult({ title: 'x', description }).missingDescription, true, JSON.stringify(description));
  }
  assert.equal(missingDescriptionResult({ description: 42 }), null, 'a wrong type is still invalid input');
  assert.equal(missingDescriptionResult(null), null);
});

test('score answers missingDescription for empty descriptions without tripping the invalid-input stop', async (t) => {
  const { env } = await fixture(t, 'nodesc');
  for (let i = 0; i < 7; i += 1) {
    const answer = ok(env, ['score', '--stdin'], job({ description: i % 2 ? '' : undefined, url: `https://boards.greenhouse.io/skipco/jobs/${200 + i}` }));
    assert.equal(answer.scored, false);
    assert.equal(answer.missingDescription, true);
    assert.match(answer.nextStep, /full text as job\.description/);
  }
  // Seven in a row (more than the 5 invalid-input stop) and a real job still scores.
  const scored = ok(env, ['score', '--stdin'], job());
  assert.equal(typeof scored.score, 'number');
  assert.notEqual(scored.scored, false);
});
