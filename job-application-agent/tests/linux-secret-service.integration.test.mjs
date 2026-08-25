import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSecretStore, LINUX_SECRET_MAX_BYTES } from '../scripts/secret-store.mjs';

const enabled = process.platform === 'linux'
  && process.env.JOB_APPLICATION_AGENT_LINUX_SECRET_SERVICE_TEST === '1';

test('Linux Secret Service supports the real profile CLI lifecycle', { skip: !enabled }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'job-agent-linux-secret-service-'));
  const service = `com.vaibhavarora.job-application-agent.test.${process.pid}.${Date.now()}`;
  const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: service,
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
  };
  t.after(async () => {
    execFileSync('secret-tool', ['clear', 'service', service, 'account', 'profile'], { stdio: 'ignore' });
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({
    version: 1,
    enabled: false,
    disclosed: true,
    graceConsumed: true,
    installationEventPending: false,
  }));

  const store = createSecretStore({ platform: 'linux', env, service });
  const first = JSON.stringify({ name: 'Secret Service integration' });
  store.writeProfile(first);
  assert.equal(store.readProfile(), first);
  assert.throws(
    () => store.writeProfile('x'.repeat(LINUX_SECRET_MAX_BYTES + 1)),
    /too large for Linux Secret Service storage/,
  );
  assert.equal(store.readProfile(), first);

  const profile = {
    name: 'Linux Test Candidate',
    email: 'candidate@example.com',
    phone: '+1 555 0100',
    location: 'Toronto, Canada',
    workAuthorization: 'Canada',
    roleFamilies: ['product-engineering'],
    seniority: ['senior'],
    skills: ['JavaScript'],
    targetLocations: ['Canada'],
    excludedLocations: [],
    workModes: ['remote'],
    industries: ['software'],
    excludedCompanies: [],
    submissionMode: 'review-each',
    yearsExperience: 8,
    autoSubmitMinScore: 80,
    manualReviewMinScore: 70,
    minMustHaveCoverage: 70,
  };
  const setResult = JSON.parse(execFileSync(process.execPath, [script, 'profile', 'set', '--stdin'], {
    env,
    input: JSON.stringify(profile),
    encoding: 'utf8',
  }));
  const checkResult = JSON.parse(execFileSync(process.execPath, [script, 'profile', 'check'], { env, encoding: 'utf8' }));
  const fieldResult = JSON.parse(execFileSync(process.execPath, [script, 'profile', 'field', 'name'], { env, encoding: 'utf8' }));

  assert.equal(setResult.stored, true);
  assert.equal(checkResult.configured, true);
  assert.deepEqual(fieldResult, { name: profile.name });
});
