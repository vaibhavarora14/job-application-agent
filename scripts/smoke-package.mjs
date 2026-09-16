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
  const guide = await execFileAsync(process.execPath, [npmCliPath,
    'exec', '--yes', `--package=file:${tarball}`, '--', 'job-application-agent', 'platforms', 'hermes',
  ], { cwd: temp });
  assert.match(guide.stdout, /external_dirs/);
  assert.match(guide.stdout, /visible ATS success/);
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
      HOME: temp,
      JOB_APPLICATION_AGENT_HOME: agentHome,
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
  const app = { id: 'smoke-app', company: 'Package Fixture', role: 'Senior Engineer', url: 'https://package.fixture.example/jobs/1', source: 'email', discoverySourceId: 'indeed', roundId: round.roundId, score: 90, status: 'submitted', submittedAt: '2026-01-01T00:00:00Z', approval: 'STANDING AUTHORIZATION' };
  run(['round','lead','--stdin'], { id: 'smoke-lead', roundId: round.roundId, sourceId: 'indeed', url: app.url, company: app.company, role: app.role, applicationId: app.id, disposition: 'qualified', observedAt: app.submittedAt, evidence: 'Synthetic package lead meets the target.' });
  assert.equal(run(['round','leads',round.roundId]).qualifiedCount, 1);
  run(['ledger','add','--stdin'], app);
  assert.equal(run(['round','complete','--stdin'], {roundId: round.roundId, concentrationReason:'stronger-fit', concentrationEvidence:'Only this source had a qualifying synthetic lead.'}).completed, true);
  const bounce = {id:'smoke-bounce',applicationId:app.id,attemptId:`initial:${app.id}`,type:'delivery-failed',occurredAt:'2026-01-02T00:00:00Z',evidenceType:'final-delivery-failure',evidence:'Matched synthetic final delivery failure.'};
  run(['ledger','delivery','--stdin'], bounce);
  run(['ledger','delivery','--stdin'], bounce);
  const failed = run(['round','status',round.roundId]);
  assert.equal(failed.confirmedCount,0);
  assert.equal(failed.needsRecovery,true);
  assert.equal(failed.completed,true);
  assert.equal(run(['ledger','review']).failedDeliveryCount,1);
  run(['ledger','retry','--stdin'],{id:'smoke-retry',applicationId:app.id,attemptId:'replacement-1',channel:'browser',url:app.url,channelVerifiedAt:'2026-01-03T00:00:00Z',occurredAt:'2026-01-03T00:10:00Z',approval:'STANDING AUTHORIZATION',evidenceType:'browser-confirmation',evidence:'Synthetic visible confirmation from the replacement channel.'});
  assert.equal(run(['ledger','deliveries',app.id]).applications[0].attempts.length,2);
  assert.equal(run(['round','status',round.roundId]).confirmedCount,1);
  assert.equal(run(['ledger','review']).recordedSubmissionCount,1);
  // The managed copy is outside npm's dependency tree: its bundled SQLite
  // runtime must work without resolving dependencies from this checkout.
  assert.equal(run(['outreach', 'policy', 'status']).enabled, false);
  assert.equal(run(['outreach', 'policy', 'enable', '--stdin'], { operationId: 'smoke-outreach-enable', timezone: 'UTC' }).enabled, true);
  assert.equal(run(['outreach', 'review']).sentVerified, 0);
  assert.equal(run(['ledger', 'review']).recordedSubmissionCount, 1);
  const outreachGuard = JSON.parse(await readFile(path.join(agentHome, 'job-application-agent', 'install.json'), 'utf8'));
  assert(outreachGuard.requiredCapabilities.includes('outreach-tracking-v1'));
  process.stdout.write('Packed npm installation smoke test passed.\n');
} finally {
  if (tarball) await rm(tarball, { force: true });
  await rm(temp, { recursive: true, force: true });
}
