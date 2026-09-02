import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import test from 'node:test';

import { discoverBoards } from '../src/discover/index.mjs';
import { openDb } from '../src/db.mjs';
import { queuedCounts } from '../src/queue.mjs';
import { isolatedEnv } from './helpers.mjs';

test('discover upserts jobs from mocked board APIs and enqueues assess once', async (t) => {
  const env = await isolatedEnv(t);
  await writeFile(env.CLOUD_BOARDS_PATH, JSON.stringify([
    { channel: 'greenhouse', slug: 'acme', company: 'Acme' },
    { channel: 'lever', slug: 'broken', company: 'Broken' },
  ]));
  const fetchImpl = async (url) => {
    if (String(url).includes('greenhouse')) {
      return {
        ok: true,
        json: async () => ({
          jobs: [{
            id: 99,
            title: 'Senior Product Engineer',
            content: '<p>TypeScript remote</p>',
            absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/99',
            location: { name: 'Remote' },
            questions: [{ id: 'first_name', label: 'First Name' }],
          }],
        }),
      };
    }
    return { ok: false, status: 500 };
  };
  const first = await discoverBoards({ fetchImpl, env, roundId: 'round-1' });
  assert.equal(first.inserted, 1);
  assert.equal(first.found, 1);
  assert.equal(first.errors.length, 1);
  const second = await discoverBoards({ fetchImpl, env, roundId: 'round-1' });
  assert.equal(second.inserted, 0);
  const jobs = openDb(env).prepare('SELECT * FROM jobs').all();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].application_channel, 'greenhouse');
  assert.match(jobs[0].questions_json, /First Name/);
  const assessJobs = queuedCounts(env).filter((row) => row.type === 'assess');
  assert.equal(assessJobs.reduce((sum, row) => sum + row.n, 0), 1);
});
