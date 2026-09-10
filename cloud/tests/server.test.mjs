import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { openDb } from '../src/db.mjs';
import { startServer } from '../src/server.mjs';
import { isolatedEnv, sampleExtras, sampleProfile } from './helpers.mjs';

async function withServer(env, fn) {
  const server = startServer(env, { embedWorker: false });
  const { port } = await server.ready;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server.close();
  }
}

test('operator API onboards, starts a round, and never calls Playwright inline', async (t) => {
  const env = await isolatedEnv(t);
  await withServer(env, async (base) => {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.profile.configured, false);

    const onboard = await fetch(`${base}/api/onboard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: sampleProfile, extras: sampleExtras }),
    });
    assert.equal(onboard.status, 200);
    const saved = await onboard.json();
    assert.equal(saved.configured, true);

    const pdf = join(env.CLOUD_DATA_DIR, 'resume.pdf');
    await writeFile(pdf, '%PDF-1.4 test');
    const resume = await fetch(`${base}/api/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: await (await import('node:fs/promises')).readFile(pdf),
    });
    assert.equal(resume.status, 200);

    const round = await fetch(`${base}/api/rounds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ count: 10 }),
    });
    assert.equal(round.status, 202);
    const body = await round.json();
    assert.match(body.id, /^round-/);

    const home = await (await fetch(`${base}/api/status`)).json();
    assert.equal(home.profile.resumePath, true);
    assert.ok(home.queue.some((row) => row.type === 'discover' && row.status === 'queued'));

    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /Needs you/);
    assert.match(html, /Find and apply/);
    assert.match(html, /Use my laptop skill profile/);
  });
});

test('cli status works against an empty isolated data dir', async (t) => {
  const env = await isolatedEnv(t);
  const { runCli } = await import('../src/cli.mjs');
  const status = await runCli(['status'], env);
  assert.equal(status.profile.configured, false);
  openDb(env); // created
});
