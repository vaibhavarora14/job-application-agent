import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

async function fixture(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `public-job-agent-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({
    version: 1,
    enabled: false,
    disclosed: true,
    graceConsumed: true,
    installationEventPending: false,
  }));
  return { directory, env: { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: directory } };
}

function cli(env, args, input) {
  return JSON.parse(execFileSync(process.execPath, [script, ...args], {
    env,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  }));
}

function cliFailure(env, args, input) {
  return spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: 'utf8',
    ...(input === undefined ? {} : { input: JSON.stringify(input) }),
  });
}

function submission(index, roundId, overrides = {}) {
  return {
    id: `round-role-${index}`,
    company: `Company ${index}`,
    role: 'Senior Product Engineer',
    url: `https://jobs.example.com/${index}`,
    employerJobId: `example:${index}`,
    source: 'ashby',
    discoverySource: 'linkedin',
    applicationChannel: 'ashby',
    roundId,
    score: 86,
    status: 'submitted',
    submittedAt: `2026-08-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
    approval: 'STANDING AUTHORIZATION',
    answers: {},
    ...overrides,
  };
}

test('persists a scoped autonomy grant and revokes future routine transmissions', async (t) => {
  const { directory, env } = await fixture(t, 'autonomy');

  const granted = cli(env, ['autonomy', 'grant', '--stdin'], { mode: 'routine-auto' });
  assert.equal(granted.enabled, true);
  assert.equal(granted.mode, 'routine-auto');
  assert.ok(granted.scopes.includes('submit'));
  assert.ok(granted.scopes.includes('send-recruiting-email'));
  assert.ok(granted.hardStops.includes('captcha'));

  const status = cli(env, ['autonomy', 'status']);
  assert.equal(status.enabled, true);
  assert.equal(status.mode, 'routine-auto');
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'autonomy.json'))).mode & 0o777, 0o600);

  const preview = cli(env, ['autonomy', 'preview']);
  assert.equal(preview.maySubmitRoutineApplications, true);
  assert.equal(preview.mayBypassHostPermissionPrompts, false);
  assert.ok(preview.hardStops.includes('legal-attestation'));

  const revoked = cli(env, ['autonomy', 'revoke']);
  assert.equal(revoked.enabled, false);
  assert.equal(cli(env, ['autonomy', 'status']).enabled, false);
});

test('counts only unique confirmed ledger submissions for an explicit round', async (t) => {
  const { directory, env } = await fixture(t, 'round');
  const started = cli(env, ['round', 'start', '--stdin'], { requestedCount: 30 });
  assert.match(started.roundId, /^round-/);

  cli(env, ['attention', 'add', '--stdin'], {
    roundId: started.roundId,
    applicationId: 'blocked-role',
    url: 'https://jobs.example.com/blocked-role',
    stage: 'submission',
    blocker: 'captcha',
    requiredActions: ['complete-captcha'],
  });

  for (let index = 0; index < 30; index += 1) {
    cli(env, ['ledger', 'add', '--stdin'], submission(index, started.roundId));
  }

  const status = cli(env, ['round', 'status', started.roundId]);
  assert.equal(status.requestedCount, 30);
  assert.equal(status.confirmedCount, 30);
  assert.equal(status.remainingCount, 0);
  assert.equal(status.blockedCount, 1);
  assert.equal(status.completed, false);

  const completed = cli(env, ['round', 'complete', '--stdin'], { roundId: started.roundId });
  assert.equal(completed.completed, true);
  assert.equal(cli(env, ['round', 'status', started.roundId]).completed, true);
  const roundEvents = (await readFile(join(directory, 'rounds.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(roundEvents.filter((event) => event.type === 'submission-confirmed').length, 30);
  assert.equal(roundEvents.length, 32);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'rounds.ndjson'))).mode & 0o777, 0o600);
});

test('does not complete a round from blocked or partially filled applications', async (t) => {
  const { env } = await fixture(t, 'incomplete-round');
  const { roundId } = cli(env, ['round', 'start', '--stdin'], { requestedCount: 2 });
  cli(env, ['ledger', 'add', '--stdin'], submission(1, roundId));
  cli(env, ['attention', 'add', '--stdin'], {
    roundId,
    applicationId: 'blocked-role',
    url: 'https://jobs.example.com/blocked-role',
    stage: 'submission',
    blocker: 'legal-attestation',
    requiredActions: ['review-legal'],
  });

  const failed = cliFailure(env, ['round', 'complete', '--stdin'], { roundId });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /2 confirmed submissions/i);
  assert.equal(cli(env, ['round', 'status', roundId]).confirmedCount, 1);
});

test('replays and prioritizes an owner-only attention queue', async (t) => {
  const { directory, env } = await fixture(t, 'attention');
  const { roundId } = cli(env, ['round', 'start', '--stdin'], { requestedCount: 30 });
  const judgment = cli(env, ['attention', 'add', '--stdin'], {
    roundId,
    applicationId: 'role-judgment',
    url: 'https://jobs.example.com/judgment',
    stage: 'answers',
    blocker: 'judgment',
    requiredActions: ['provide-judgment'],
  });
  const captcha = cli(env, ['attention', 'add', '--stdin'], {
    roundId,
    applicationId: 'role-captcha',
    url: 'https://jobs.example.com/captcha',
    stage: 'submission',
    blocker: 'captcha',
    requiredActions: ['complete-captcha'],
  });

  const before = cli(env, ['attention', 'list']);
  assert.deepEqual(before.items.map((item) => item.id), [captcha.id, judgment.id]);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'attention.ndjson'))).mode & 0o777, 0o600);

  cli(env, ['attention', 'resolve', '--stdin'], { id: captcha.id });
  const after = cli(env, ['attention', 'list']);
  assert.deepEqual(after.items.map((item) => item.id), [judgment.id]);
});

test('qualifies only reproducible general-purpose friction for a public PR', async (t) => {
  const { directory, env } = await fixture(t, 'friction');
  const local = cli(env, ['friction', 'record', '--stdin'], {
    stage: 'upload',
    ats: 'ashby',
    errorCode: 'candidate-specific-document',
    reproducible: true,
    general: false,
  });
  const general = cli(env, ['friction', 'record', '--stdin'], {
    stage: 'upload',
    ats: 'ashby',
    errorCode: 'direct-upload-fallback-opened',
    reproducible: true,
    general: true,
  });

  assert.equal(local.qualifiesForPr, false);
  assert.equal(general.qualifiesForPr, true);
  const listed = cli(env, ['friction', 'list']);
  assert.equal(listed.items.length, 2);
  assert.deepEqual(listed.prCandidates.map((item) => item.id), [general.id]);
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, 'friction.ndjson'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(directory, 'friction.ndjson'), 'utf8')).includes('candidate@example.com'), false);
});

test('preserves independent discovery and application channel attribution', async (t) => {
  const { directory, env } = await fixture(t, 'attribution');
  const { roundId } = cli(env, ['round', 'start', '--stdin'], { requestedCount: 1 });
  cli(env, ['ledger', 'add', '--stdin'], submission(0, roundId));
  const stored = JSON.parse((await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim());
  assert.equal(stored.source, 'ashby');
  assert.equal(stored.discoverySource, 'linkedin');
  assert.equal(stored.applicationChannel, 'ashby');
  assert.equal(stored.roundId, roundId);

  const companyHistory = cli(env, ['ledger', 'check', '--stdin'], {
    id: 'another-role',
    company: 'Company 0',
    role: 'Staff Backend Engineer',
    url: 'https://jobs.example.com/another-role',
    employerJobId: 'example:another-role',
  });
  assert.equal(companyHistory.duplicate, false);
  assert.equal(companyHistory.sameCompany, true);
  assert.equal(companyHistory.companyApplications.length, 1);
});
