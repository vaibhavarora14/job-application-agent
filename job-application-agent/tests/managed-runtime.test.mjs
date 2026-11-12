// #270: a skills-registry, ClawHub, or copied skill directory cannot assess or apply
// until `npx job-application-agent@latest install`. A managed install or skillVersion
// upgrade prompts one review-each job and does not auto-submit.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkForUpdate, NPM_LATEST_URL } from '../scripts/update-check.mjs';

const skillDir = fileURLToPath(new URL('..', import.meta.url));

function registry(version) {
  return async () => ({ ok: true, json: async () => ({ version }) });
}

async function home(config) {
  const root = await mkdtemp(path.join(tmpdir(), 'jaa-managed-runtime-'));
  const agentHome = path.join(root, '.agents');
  if (config) {
    await mkdir(path.join(agentHome, 'job-application-agent'), { recursive: true });
    await writeFile(path.join(agentHome, 'job-application-agent', 'install.json'), JSON.stringify(config));
  }
  return {
    root,
    agentHome,
    env: { JOB_APPLICATION_AGENT_HOME: agentHome, JOB_APPLICATION_AGENT_UPDATE_CHECK_URL: NPM_LATEST_URL },
  };
}

test('a copied skill with no managed install tells updates check to install before assess or apply', async () => {
  const f = await home(null);
  const result = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    fetchImpl: registry('3.8.6'),
    copiedSkill: true,
  });
  assert.equal(result.managedRuntime.installed, false);
  assert.equal(result.managedRuntime.command, 'npx job-application-agent@latest install');
  assert.match(result.managedRuntime.instruction, /same machine as the browser/);
  assert.match(result.managedRuntime.instruction, /assess or apply/);
  assert.equal(result.firstJob, undefined);
});

test('the package tree does not demand a managed install and does not invent a first job', async () => {
  const f = await home(null);
  const result = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    fetchImpl: registry('3.8.6'),
    copiedSkill: false,
  });
  assert.equal(result.managedRuntime, undefined);
  assert.equal(result.firstJob, undefined);
});

test('a fresh managed install prompts one review-each job once and records the skill version', async () => {
  const f = await home({ installed: true, installedVersion: '3.8.6', automaticUpdates: false });
  const first = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    fetchImpl: registry('3.8.6'),
  });
  assert.equal(first.firstJob.reason, 'install');
  assert.equal(first.firstJob.previousSkillVersion, null);
  assert.equal(first.firstJob.skillVersion, '3.8.6');
  assert.equal(first.firstJob.mode, 'review-each');
  assert.equal(first.firstJob.autoSubmit, false);
  assert.equal(first.firstJob.recordOnlyConfirmed, true);
  assert.equal(first.firstJob.jobsUrl, 'https://jobappagent.com/jobs');
  assert.match(first.firstJob.instruction, /Do not auto-submit/);
  assert.match(first.firstJob.instruction, /Do not invent fill counts/);
  assert.match(first.firstJob.instruction, /visible success/);
  const second = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    fetchImpl: registry('3.8.6'),
  });
  assert.equal(second.firstJob, undefined);
  const config = JSON.parse(await readFile(path.join(f.agentHome, 'job-application-agent', 'install.json'), 'utf8'));
  assert.equal(config.firstJobPromptedVersion, '3.8.6');
  assert.equal(config.installed, true);
});

test('a skillVersion upgrade prompts one review-each job and keeps the earlier prompted version visible', async () => {
  const f = await home({
    installed: true,
    installedVersion: '3.8.6',
    automaticUpdates: false,
    firstJobPromptedVersion: '3.8.5',
  });
  const result = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    fetchImpl: registry('3.8.6'),
  });
  assert.equal(result.firstJob.reason, 'upgrade');
  assert.equal(result.firstJob.previousSkillVersion, '3.8.5');
  assert.equal(result.firstJob.mode, 'review-each');
  assert.equal(result.firstJob.autoSubmit, false);
  const again = await checkForUpdate({
    currentVersion: '3.8.6',
    env: f.env,
    homeDir: f.root,
    fetchImpl: registry('3.8.6'),
  });
  assert.equal(again.firstJob, undefined);
});

function runCli(script, args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input === undefined ? '' : input);
  });
}

test('a copied skill refuses score and ledger add until the managed runtime is installed', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'jaa-copied-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dest = path.join(root, '.agents', 'skills', 'job-application-agent');
  await mkdir(path.join(root, '.agents', 'skills'), { recursive: true });
  await cp(skillDir, dest, {
    recursive: true,
    filter: (source) => !source.includes(`${path.join('job-application-agent', 'tests')}`),
  });
  const script = path.join(dest, 'scripts', 'job-application.mjs');
  const state = path.join(root, 'state');
  await mkdir(state, { recursive: true });
  await writeFile(path.join(state, 'telemetry.json'), JSON.stringify({
    version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false,
  }));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    JOB_APPLICATION_AGENT_HOME: path.join(root, '.agents'),
    JOB_APPLICATION_AGENT_STATE_DIR: state,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: path.join(root, 'cloud-config.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_NO_UPDATE_CHECK: '1',
  };

  const help = await runCli(script, ['help'], env);
  assert.equal(help.code, 0, help.stderr);

  const score = await runCli(script, ['score', '--stdin'], env, JSON.stringify({
    title: 'Engineer', company: 'Acme', description: '',
  }));
  assert.equal(score.code, 1, score.stdout);
  assert.match(score.stderr, /managed runtime must be installed before assess or apply/i);
  assert.match(score.stderr, /npx job-application-agent@latest install/);
  assert.match(score.stderr, /same machine as the browser/);
  await assert.rejects(readFile(path.join(state, 'applications.ndjson'), 'utf8'), { code: 'ENOENT' });

  const added = await runCli(script, ['ledger', 'add', '--stdin'], env, JSON.stringify({
    id: 'acme-1', company: 'Acme', role: 'Engineer', url: 'https://boards.greenhouse.io/acme/jobs/1',
    source: 'greenhouse', score: 80, status: 'submitted', submittedAt: '2026-11-01T00:00:00.000Z',
    approval: 'APPROVE SUBMIT', answers: {},
  }));
  assert.equal(added.code, 1, added.stdout);
  assert.match(added.stderr, /managed runtime must be installed before assess or apply/i);
  await assert.rejects(readFile(path.join(state, 'applications.ndjson'), 'utf8'), { code: 'ENOENT' });

  const updates = await runCli(script, ['updates', 'check'], env);
  assert.equal(updates.code, 0, updates.stderr);
  const updateBody = JSON.parse(updates.stdout);
  assert.equal(updateBody.managedRuntime.installed, false);
  assert.equal(updateBody.firstJob, undefined);

  await mkdir(path.join(root, '.agents', 'job-application-agent'), { recursive: true });
  await writeFile(path.join(root, '.agents', 'job-application-agent', 'install.json'), JSON.stringify({
    installed: true, installedVersion: '3.8.6', automaticUpdates: false,
  }));
  const opened = await runCli(script, ['score', '--stdin'], env, JSON.stringify({ description: '' }));
  assert.equal(opened.code, 0, opened.stderr);
  assert.equal(JSON.parse(opened.stdout).missingDescription, true);
  const prompted = JSON.parse((await runCli(script, ['updates', 'check'], env)).stdout);
  assert.equal(prompted.firstJob.mode, 'review-each');
  assert.equal(prompted.firstJob.autoSubmit, false);
  assert.equal(prompted.managedRuntime, undefined);
  const quiet = JSON.parse((await runCli(script, ['updates', 'check'], env)).stdout);
  assert.equal(quiet.firstJob, undefined);
});
