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

test('allows a distinct same-company role after 15 quiet days', async (t) => {
  const { env } = await fixture(t, 'company-cooldown');
  const submittedAt = new Date(Date.now() - (16 * 86_400_000)).toISOString();

  cli(env, ['ledger', 'add', '--stdin'], {
    id: 'example-backend-role',
    company: 'Example',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.example.com/backend-123',
    employerJobId: 'example:backend-123',
    source: 'company',
    score: 88,
    status: 'submitted',
    submittedAt,
    approval: 'STANDING AUTHORIZATION',
    answers: {},
  });

  const check = cli(env, ['ledger', 'check', '--stdin'], {
    id: 'example-fullstack-role',
    company: 'Example',
    role: 'Staff Full Stack Engineer',
    url: 'https://jobs.example.com/fullstack-456',
    employerJobId: 'example:fullstack-456',
  });

  assert.equal(check.duplicate, false);
  assert.equal(check.sameCompany, true);
  assert.equal(check.companyReapply.eligible, true);
  assert.equal(check.companyReapply.decision, 'eligible-after-cooldown');
  assert.equal(check.companyReapply.cooldownDays, 15);
  assert.equal(check.companyReapply.hasFollowUp, false);
});

test('keeps same-company roles in review during cooldown or after follow-up', async (t) => {
  const { env } = await fixture(t, 'company-follow-up');
  const recentSubmittedAt = new Date(Date.now() - (5 * 86_400_000)).toISOString();

  cli(env, ['ledger', 'add', '--stdin'], {
    id: 'recent-role',
    company: 'Recent Co',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.recent.example/backend-123',
    employerJobId: 'recent:backend-123',
    source: 'company',
    score: 88,
    status: 'submitted',
    submittedAt: recentSubmittedAt,
    approval: 'STANDING AUTHORIZATION',
    answers: {},
  });

  const recent = cli(env, ['ledger', 'check', '--stdin'], {
    id: 'recent-fullstack-role',
    company: 'Recent Co',
    role: 'Staff Full Stack Engineer',
    url: 'https://jobs.recent.example/fullstack-456',
  });
  assert.equal(recent.companyReapply.eligible, false);
  assert.equal(recent.companyReapply.decision, 'cooldown-active');

  const oldSubmittedAt = new Date(Date.now() - (20 * 86_400_000)).toISOString();
  cli(env, ['ledger', 'add', '--stdin'], {
    id: 'followed-role',
    company: 'Followed Co',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.followed.example/backend-123',
    employerJobId: 'followed:backend-123',
    source: 'company',
    score: 88,
    status: 'submitted',
    submittedAt: oldSubmittedAt,
    approval: 'STANDING AUTHORIZATION',
    answers: {},
  });
  cli(env, ['ledger', 'outcome', '--stdin'], {
    id: 'followed-role',
    status: 'rejected',
    occurredAt: new Date(Date.now() - (18 * 86_400_000)).toISOString(),
  });

  const followed = cli(env, ['ledger', 'check', '--stdin'], {
    id: 'followed-fullstack-role',
    company: 'Followed Co',
    role: 'Staff Full Stack Engineer',
    url: 'https://jobs.followed.example/fullstack-456',
  });
  assert.equal(followed.companyReapply.eligible, false);
  assert.equal(followed.companyReapply.decision, 'follow-up-present');
  assert.equal(followed.companyReapply.hasFollowUp, true);
});

test('ships a filterable global discovery source catalog with Employable', async (t) => {
  const { directory, env } = await fixture(t, 'source-catalog');
  const catalog = cli(env, ['sources', 'list']);
  const employable = catalog.sources.find((source) => source.id === 'employable-ai');

  assert.ok(employable);
  assert.equal(employable.kind, 'job-board');
  assert.equal(employable.requiresSession, true);
  assert.equal(employable.verification, 'direct-employer-or-ats');

  const filtered = cli(env, ['sources', 'list', '--stdin'], {
    regions: ['global'],
    roleFamilies: ['engineering'],
  });
  assert.ok(filtered.sources.some((source) => source.id === 'employable-ai'));

  cli(env, ['ledger', 'add', '--stdin'], {
    id: 'employable-sourced-role',
    company: 'Catalog Example',
    role: 'Staff Product Engineer',
    url: 'https://jobs.catalog.example/staff-product-engineer',
    source: 'company',
    discoverySource: 'job-board',
    discoverySourceId: 'employable-ai',
    applicationChannel: 'company',
    score: 90,
    status: 'submitted',
    submittedAt: new Date().toISOString(),
    approval: 'STANDING AUTHORIZATION',
    answers: {},
  });
  const [stored] = (await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(stored.discoverySourceId, 'employable-ai');
});

test('queues sanitized repeatable source suggestions locally for public-registry review', async (t) => {
  const { directory, env } = await fixture(t, 'source-suggestions');
  const suggestion = cli(env, ['sources', 'suggest', '--stdin'], {
    name: 'Example Engineering Board',
    baseUrl: 'https://jobs.example.org/engineering',
    kind: 'job-board',
    regions: ['global'],
    roleFamilies: ['engineering'],
    requiresSession: false,
  });

  assert.equal(suggestion.queued, true);
  assert.equal(suggestion.suggestion.baseUrl, 'https://jobs.example.org/engineering');
  assert.equal((await stat(join(directory, 'source-suggestions.ndjson'))).mode & 0o777, 0o600);

  const pending = cli(env, ['sources', 'pending']);
  assert.equal(pending.count, 1);
  assert.equal(pending.suggestions[0].name, 'Example Engineering Board');

  const rejected = cliFailure(env, ['sources', 'suggest', '--stdin'], {
    name: 'Personal referral',
    baseUrl: 'https://linkedin.com/in/some-person',
    kind: 'user-supplied',
    regions: ['global'],
    roleFamilies: ['engineering'],
    requiresSession: true,
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /profile or personal URL/i);
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
