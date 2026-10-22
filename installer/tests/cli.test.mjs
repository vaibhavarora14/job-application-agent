import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';

async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-agent-cli-'));
  const packageRoot = path.join(root, 'package');
  const agentHome = path.join(root, '.agents');
  await mkdir(path.join(packageRoot, 'job-application-agent', 'scripts'), { recursive: true });
  await writeFile(path.join(packageRoot, 'job-application-agent', 'SKILL.md'), '# Skill\n');
  await writeFile(path.join(packageRoot, 'job-application-agent', 'scripts', 'job-application.mjs'), 'export {};\n');
  return { root, packageRoot, agentHome };
}

async function enableLegacyAutoUpdates(agentHome) {
  // Simulate an install made before notify-only became the default: automatic
  // updates on, and the one-time notice not yet shown.
  const configPath = path.join(agentHome, 'job-application-agent', 'install.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  delete config.autoUpdateNoticeShown;
  await writeFile(configPath, `${JSON.stringify({ ...config, automaticUpdates: true }, null, 2)}\n`);
}

test('a new install is notify-only by default and status reports the installed version', async () => {
  const f = await setup();
  const output = [];
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: value => output.push(value) });
  await runCli(['status'], { agentHome: f.agentHome, homeDir: f.root, output: value => output.push(value) });
  assert.match(output.join('\n'), /3\.0\.0/);
  assert.match(output.join('\n'), /automatic updates: disabled \(notify-only/i);
  assert.match(output.join('\n'), /updates enable/);
  assert.doesNotMatch(output.join('\n'), /automatic updates are on/i);
});

test('updates enable is the explicit opt-in and shows no legacy notice', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  const output = [];
  await runCli(['updates', 'enable'], { agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: value => output.push(value) });
  await runCli(['status'], { agentHome: f.agentHome, homeDir: f.root, output: value => output.push(value) });
  assert.match(output.join('\n'), /automatic updates: enabled/i);
  assert.doesNotMatch(output.join('\n'), /automatic updates are on/i);
});

test('an existing auto-update install keeps auto-update and prints the notice exactly once', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await enableLegacyAutoUpdates(f.agentHome);
  const first = [];
  await runCli(['status'], { agentHome: f.agentHome, homeDir: f.root, output: value => first.push(value) });
  assert.match(first.join('\n'), /automatic updates: enabled/i);
  assert.match(first.join('\n'), /Automatic updates are ON/);
  assert.match(first.join('\n'), /To keep automatic updates, do nothing/);
  assert.match(first.join('\n'), /updates disable/);
  const second = [];
  await runCli(['status'], { agentHome: f.agentHome, homeDir: f.root, output: value => second.push(value) });
  assert.doesNotMatch(second.join('\n'), /Automatic updates are ON/);
  // Updating an existing install never silently turns its automatic updates off.
  await runCli(['update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  const config = JSON.parse(await readFile(path.join(f.agentHome, 'job-application-agent', 'install.json'), 'utf8'));
  assert.equal(config.automaticUpdates, true);
  assert.equal(config.autoUpdateNoticeShown, true);
});

test('auto-update is a no-op when updates are disabled', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await runCli(['updates', 'disable'], { agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await writeFile(path.join(f.packageRoot, 'job-application-agent', 'SKILL.md'), '# New skill\n');
  const output = [];
  await runCli(['auto-update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: value => output.push(value) });
  assert.match(output.join('\n'), /disabled/i);
  assert.equal(await readFile(path.join(f.agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# Skill\n');
});

test('auto-update does not replace an already-current installation or reload its scheduler', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await enableLegacyAutoUpdates(f.agentHome);
  const marker = path.join(f.agentHome, 'skills', 'job-application-agent', 'local-marker');
  await writeFile(marker, 'preserve');
  const output = [];
  await runCli(['auto-update'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'darwin', output: value => output.push(value) });
  assert.equal(await readFile(marker, 'utf8'), 'preserve');
  assert.match(output.join('\n'), /already current/i);
});

test('auto-update replaces an older skill without reloading the running scheduler', async () => {
  const f = await setup();
  await runCli(['install'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, homeDir: f.root, platform: 'test', scheduler: false, output: () => {} });
  await enableLegacyAutoUpdates(f.agentHome);
  await writeFile(path.join(f.packageRoot, 'job-application-agent', 'SKILL.md'), '# New skill\n');
  await runCli(['auto-update'], { packageRoot: f.packageRoot, packageVersion: '3.1.0', agentHome: f.agentHome, homeDir: f.root, platform: 'darwin', output: () => {} });
  assert.equal(await readFile(path.join(f.agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8'), '# New skill\n');
});

test('unknown commands fail with usage instead of silently installing', async () => {
  const f = await setup();
  await assert.rejects(runCli(['surprise'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, output: () => {} }), /usage/i);
});

test('apply with a valid https URL prints the review-mode prompt', async () => {
  const f = await setup();
  const url = 'https://jobs.example.com/boards/acme/jobs/123';
  const output = [];
  const logs = [];
  const result = await runCli(['apply', url], {
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    agentHome: f.agentHome,
    homeDir: f.root,
    env: {},
    log: (message) => logs.push(message),
    output: (value) => output.push(value),
  });
  const text = output.join('\n');
  assert.match(text, /review mode/i);
  assert.match(text, /do not submit/i);
  assert.match(text, /approval/i);
  assert.match(text, /Never auto-submit/i);
  assert.match(text, /https:\/\/jobs\.example\.com\/boards\/acme\/jobs\/123/);
  assert.match(text, /npx job-application-agent@latest install/);
  assert.match(text, /review mode required/i);
  assert.equal(result.reviewMode, true);
  assert.equal(result.url, url);
  assert.equal(result.applyKind, 'live');
  assert.equal(result.liveApply, true);
  assert.match(logs.join('\n'), /LIVE_APPLY/);
});

test('apply without a URL fails with usage', async () => {
  const f = await setup();
  await assert.rejects(
    runCli(['apply'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, output: () => {} }),
    /usage/i,
  );
});

test('apply with an invalid URL fails', async () => {
  const f = await setup();
  await assert.rejects(
    runCli(['apply', 'not-a-url'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, output: () => {} }),
    /invalid apply url/i,
  );
  await assert.rejects(
    runCli(['apply', 'http://jobs.example.com/role'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, output: () => {} }),
    /must be https/i,
  );
  await assert.rejects(
    runCli(['apply', 'https://user:secret@jobs.example.com/role'], { packageRoot: f.packageRoot, packageVersion: '3.0.0', agentHome: f.agentHome, output: () => {} }),
    /username or password/i,
  );
});

test('apply with launchPrompt returns structured result without printing', async () => {
  const f = await setup();
  const url = 'https://boards.greenhouse.io/acme/jobs/42';
  const output = [];
  const result = await runCli(['apply', url], {
    packageRoot: f.packageRoot,
    packageVersion: '3.0.0',
    agentHome: f.agentHome,
    homeDir: f.root,
    env: {},
    log: () => {},
    launchPrompt: true,
    output: (value) => output.push(value),
  });
  assert.equal(output.length, 0);
  assert.equal(result.reviewMode, true);
  assert.equal(result.url, url);
  assert.match(result.prompt, /review mode/i);
  assert.match(result.prompt, /Never auto-submit/);
  assert.match(result.confirmation, /review mode required/i);
});

test('help, --help and -h print usage and succeed; unknown commands still fail', async () => {
  for (const arg of ['help', '--help', '-h']) {
    const output = [];
    const result = await runCli([arg], { packageRoot: '/nonexistent', packageVersion: '0.0.0', output: value => output.push(value) });
    assert.match(output.join('\n'), /^Usage:\n {2}job-application-agent install/);
    assert.match(result.usage, /job-application-agent apply <url>/);
  }
  await assert.rejects(() => runCli(['definitely-not-a-command'], { packageRoot: '/nonexistent', packageVersion: '0.0.0', output: () => {} }), /Usage:/);
});

test('the npm bin exits 0 for help flags and 1 for unknown commands', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const bin = fileURLToPath(new URL('../../bin/job-application-agent.mjs', import.meta.url));
  for (const arg of ['help', '--help', '-h']) {
    const run = spawnSync(process.execPath, [bin, arg], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${arg}: ${run.stderr}`);
    assert.match(run.stdout, /^Usage:/);
    assert.equal(run.stderr, '');
  }
  const bad = spawnSync(process.execPath, [bin, 'definitely-not-a-command'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage:/);
});
