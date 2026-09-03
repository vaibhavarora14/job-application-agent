import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { applyLocalDefaults, parseDotEnv } from '../src/env.mjs';
import { startLocal } from '../src/local.mjs';
import { importFromLocalSkill, importLocalCandidate } from '../src/skill.mjs';
import { isolatedEnv, sampleExtras, sampleProfile } from './helpers.mjs';

test('parseDotEnv ignores comments and does not require quotes', () => {
  const parsed = parseDotEnv('# x\nHOST=127.0.0.1\nPORT="8787"\nEMPTY=\n');
  assert.equal(parsed.HOST, '127.0.0.1');
  assert.equal(parsed.PORT, '8787');
  assert.equal(parsed.EMPTY, '');
});

test('local defaults bind localhost and keep data under cloud/data', () => {
  const env = applyLocalDefaults({}, { cloudRoot: '/tmp/job-agent-cloud' });
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.PORT, '8787');
  assert.equal(env.CLOUD_DATA_DIR, '/tmp/job-agent-cloud/data');
  assert.equal(env.CLOUD_EMBED_WORKER, '1');
});

test('importLocalCandidate copies profile and résumé into cloud state', async (t) => {
  const env = await isolatedEnv(t);
  const resume = join(env.CLOUD_DATA_DIR, 'source.pdf');
  await writeFile(resume, '%PDF-1.4 ' + 'x'.repeat(1200));
  const result = await importLocalCandidate({
    profile: sampleProfile,
    extras: sampleExtras,
    resumePath: resume,
    env,
  });
  assert.equal(result.configured, true);
  assert.ok(result.resumePath.endsWith('resume.pdf'));
});

test('onboard --from-skill explains a missing laptop profile', async (t) => {
  const env = await isolatedEnv(t);
  const { runCli } = await import('../src/cli.mjs');
  await assert.rejects(() => runCli(['onboard', '--from-skill'], env), /laptop skill profile/);
});

test('importFromLocalSkill copies an injected laptop profile and résumé', async (t) => {
  const env = await isolatedEnv(t);
  const hostDir = join(env.CLOUD_DATA_DIR, 'host-skill');
  await mkdir(hostDir, { recursive: true });
  const resume = join(hostDir, 'resume.pdf');
  await writeFile(resume, '%PDF-1.4 ' + 'y'.repeat(1200));
  const imported = await importFromLocalSkill(env, {
    readProfile: () => JSON.stringify(sampleProfile),
    resumePath: resume,
  });
  assert.equal(imported.configured, true);
  assert.ok(imported.resumePath);
});

test('local launcher starts the operator page without Playwright', async (t) => {
  const env = await isolatedEnv(t);
  const started = await startLocal(env, { cloudRoot: env.CLOUD_DATA_DIR });
  t.after(() => started.close());
  const html = await (await fetch(started.url)).text();
  assert.match(html, /Use my laptop skill profile/);
  assert.match(html, /Find and apply/);
  const fromSkill = await fetch(`${started.url}/api/onboard/from-skill`, { method: 'POST' });
  assert.equal(fromSkill.status, 500);
});
