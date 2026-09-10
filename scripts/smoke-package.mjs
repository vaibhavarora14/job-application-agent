import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();
const packageManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(path.join(os.tmpdir(), 'job-application-agent-package-'));
const agentHome = path.join(temp, '.agents');
const npmCliPath = process.env.npm_execpath;
let tarball;

try {
  if (!npmCliPath) throw new Error('npm_execpath is required; run this check through npm run smoke:package.');
  const packed = await execFileAsync(process.execPath, [npmCliPath, 'pack', '--silent', '--ignore-scripts'], { cwd: root });
  tarball = path.join(root, packed.stdout.trim().split(/\r?\n/).at(-1));
  await execFileAsync(process.execPath, [npmCliPath,
    'exec', '--yes', `--package=file:${tarball}`, '--', 'job-application-agent', 'install',
  ], {
    cwd: temp,
    env: {
      ...process.env,
      HOME: temp,
      JOB_APPLICATION_AGENT_HOME: agentHome,
      JOB_APPLICATION_AGENT_NO_SCHEDULER: '1',
    },
  });

  const skill = await readFile(path.join(agentHome, 'skills', 'job-application-agent', 'SKILL.md'), 'utf8');
  const config = JSON.parse(await readFile(path.join(agentHome, 'job-application-agent', 'install.json'), 'utf8'));
  if (!skill.includes('# Job Application Agent')) throw new Error('Packed skill did not install correctly.');
  if (config.installedVersion !== packageManifest.version || config.automaticUpdates !== true) throw new Error('Packed installer state is incorrect.');
  if (process.platform !== 'win32' && ((await stat(path.join(agentHome, 'job-application-agent', 'install.json'))).mode & 0o777) !== 0o600) throw new Error('Install configuration permissions are not private.');

  // Exercise the installed npm artifact with synthetic state, never the user's profile.
  const stateDir = path.join(temp, 'coverage-state');
  await mkdir(stateDir, { mode: 0o700 });
  await writeFile(path.join(stateDir, 'telemetry.json'), JSON.stringify({ version: 1, enabled: false, disclosed: true, graceConsumed: true, installationEventPending: false }), { mode: 0o600 });
  const installedCli = await realpath(path.join(agentHome, 'skills', 'job-application-agent', 'scripts', 'job-application.mjs'));
  const run = (args, input) => JSON.parse(execFileSync(process.execPath, [installedCli, ...args], {
    cwd: temp,
    encoding: 'utf8',
    input: input === undefined ? undefined : JSON.stringify(input),
    env: {
      ...process.env,
      JOB_APPLICATION_AGENT_STATE_DIR: stateDir,
      JOB_APPLICATION_AGENT_CLOUD_CONFIG: path.join(temp, 'no-live-cloud-config.json'),
      JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    },
  }));
  const round = run(['round', 'start', '--stdin'], { requestedCount: 1 });
  assert.equal(round.discoveryPolicy.minSources, 3);
  assert.equal(round.discoveryPolicy.concentrationThresholdPercent, 60);
  assert.equal(run(['round', 'status', round.roundId]).discovery.coverageSatisfied, false);
  for (const sourceId of ['linkedin-jobs-feed', 'indeed', 'hacker-news-who-is-hiring']) {
    run(['round', 'source', '--stdin'], { roundId: round.roundId, sourceId, status: 'searched', reviewedCount: 0, qualifiedCount: 0, evidence: 'Synthetic package verification: no matching results.' });
  }
  const coverage = run(['round', 'status', round.roundId]).discovery;
  assert.equal(coverage.coverageSatisfied, true);
  assert.equal(coverage.searchedSourceCount, 3);
  process.stdout.write('Packed npm installation smoke test passed.\n');
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(temp, { recursive: true, force: true });
}
