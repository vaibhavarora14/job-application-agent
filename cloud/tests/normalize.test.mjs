import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJob, guessWorkMode, jobId } from '../src/discover/normalize.mjs';

test('canonicalJob hashes a stable id and keeps https apply urls', () => {
  const job = canonicalJob({
    company: 'Acme',
    role: 'Senior Product Engineer',
    title: 'Senior Product Engineer',
    description: 'Build products.',
    url: 'https://job-boards.greenhouse.io/acme/jobs/123#apply',
    employerJobId: 'greenhouse:123',
    applicationChannel: 'greenhouse',
    locations: ['Remote'],
  });
  assert.equal(job.url, 'https://job-boards.greenhouse.io/acme/jobs/123');
  assert.equal(job.id, jobId(job));
  assert.equal(job.workMode, 'remote');
});

test('canonicalJob rejects non-https urls', () => {
  assert.throws(() => canonicalJob({
    company: 'Acme',
    title: 'Role',
    url: 'http://example.com/job',
    applicationChannel: 'greenhouse',
  }), /https/);
});

test('guessWorkMode reads listing text', () => {
  assert.equal(guessWorkMode('Hybrid in Berlin', false), 'hybrid');
  assert.equal(guessWorkMode('Office in NYC', false), 'onsite');
  assert.equal(guessWorkMode('Something else', true), 'remote');
});
