import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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

function cliConcurrent(env, args, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
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

test('blocks a different role at the same company during the 15-day cooldown', async (t) => {
  const { env } = await fixture(t, 'company-cooldown-enforced');
  const recent = new Date(Date.now() - (5 * 86_400_000)).toISOString();
  const now = new Date().toISOString();
  cli(env, ['ledger', 'add', '--stdin'], submission(100, undefined, {
    id: 'example-backend-role',
    company: 'Example',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.example.com/backend-100',
    employerJobId: 'example:backend-100',
    submittedAt: recent,
  }));

  const check = cli(env, ['ledger', 'check', '--stdin'], {
    id: 'example-product-role',
    company: 'Example',
    role: 'Staff Product Engineer',
    url: 'https://jobs.example.com/product-101',
    employerJobId: 'example:product-101',
  });
  assert.equal(check.companyReapply.decision, 'cooldown-active');
  assert.equal(check.companyReapply.eligible, false);

  const blocked = cliFailure(env, ['ledger', 'add', '--stdin'], submission(101, undefined, {
    id: 'example-product-role',
    company: 'Example',
    role: 'Staff Product Engineer',
    url: 'https://jobs.example.com/product-101',
    employerJobId: 'example:product-101',
    submittedAt: now,
  }));

  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /reapplication cooldown is active/i);
  assert.match(blocked.stderr, /CANDIDATE APPROVED EARLY REAPPLICATION/);
});

test('records bounded evidence for an explicitly approved early reapplication', async (t) => {
  const { directory, env } = await fixture(t, 'company-cooldown-override');
  const recent = new Date(Date.now() - (5 * 86_400_000)).toISOString();
  const now = new Date().toISOString();
  cli(env, ['ledger', 'add', '--stdin'], submission(110, undefined, {
    id: 'override-backend-role',
    company: 'Override Co',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.example.com/override-backend-110',
    submittedAt: recent,
  }));

  const result = cli(env, ['ledger', 'add', '--stdin'], {
    ...submission(111, undefined, {
      id: 'override-product-role',
      company: 'Override Co',
      role: 'Staff Product Engineer',
      url: 'https://jobs.example.com/override-product-111',
      submittedAt: now,
    }),
    companyReapplyOverride: 'CANDIDATE APPROVED EARLY REAPPLICATION',
  });

  assert.equal(result.recorded, 'override-product-role');
  const stored = (await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(stored[1].reapplicationApproval, 'candidate-explicit');
  assert.equal(JSON.stringify(stored).includes('CANDIDATE APPROVED EARLY REAPPLICATION'), false);
  assert.equal('companyReapplyOverride' in stored[1], false);
});

test('requires explicit approval when the latest company application has a follow-up', async (t) => {
  const { directory, env } = await fixture(t, 'company-follow-up-override');
  const old = new Date(Date.now() - (30 * 86_400_000)).toISOString();
  const followUp = new Date(Date.now() - (20 * 86_400_000)).toISOString();
  const now = new Date().toISOString();
  cli(env, ['ledger', 'add', '--stdin'], submission(120, undefined, {
    id: 'follow-up-backend-role',
    company: 'Follow Up Co',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.example.com/follow-up-backend-120',
    submittedAt: old,
  }));
  cli(env, ['ledger', 'outcome', '--stdin'], {
    id: 'follow-up-backend-role',
    status: 'rejected',
    occurredAt: followUp,
  });

  const candidate = submission(121, undefined, {
    id: 'follow-up-product-role',
    company: 'Follow Up Co',
    role: 'Staff Product Engineer',
    url: 'https://jobs.example.com/follow-up-product-121',
    submittedAt: now,
  });
  const blocked = cliFailure(env, ['ledger', 'add', '--stdin'], candidate);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /recorded follow-up/i);

  const result = cli(env, ['ledger', 'add', '--stdin'], {
    ...candidate,
    companyReapplyOverride: 'CANDIDATE APPROVED EARLY REAPPLICATION',
  });
  assert.equal(result.recorded, 'follow-up-product-role');
  const stored = (await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(stored[1].reapplicationApproval, 'candidate-explicit');
});

test('allows a genuinely different role after 15 full quiet days', async (t) => {
  const { env } = await fixture(t, 'company-cooldown-complete');
  const old = new Date(Date.now() - (16 * 86_400_000)).toISOString();
  cli(env, ['ledger', 'add', '--stdin'], submission(130, undefined, {
    id: 'quiet-backend-role',
    company: 'Quiet Co',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.example.com/quiet-backend-130',
    submittedAt: old,
  }));

  const check = cli(env, ['ledger', 'check', '--stdin'], {
    id: 'quiet-product-role',
    company: 'Quiet Co',
    role: 'Staff Product Engineer',
    url: 'https://jobs.example.com/quiet-product-131',
    employerJobId: 'example:quiet-product-131',
  });
  assert.equal(check.companyReapply.decision, 'eligible-after-cooldown');
  assert.equal(check.companyReapply.eligible, true);

  const result = cli(env, ['ledger', 'add', '--stdin'], submission(131, undefined, {
    id: 'quiet-product-role',
    company: 'Quiet Co',
    role: 'Staff Product Engineer',
    url: 'https://jobs.example.com/quiet-product-131',
    employerJobId: 'example:quiet-product-131',
    submittedAt: new Date().toISOString(),
  }));
  assert.equal(result.recorded, 'quiet-product-role');
});

test('requires the requisition override for same-role aliases', async (t) => {
  const { directory, env } = await fixture(t, 'same-role-alias');
  const recent = new Date(Date.now() - (2 * 86_400_000)).toISOString();
  cli(env, ['ledger', 'add', '--stdin'], submission(140, undefined, {
    id: 'alias-backend-original',
    company: 'Alias Co',
    role: 'Senior Backend Developer',
    url: 'https://jobs.example.com/alias-backend-140',
    employerJobId: 'alias:140',
    submittedAt: recent,
  }));
  const candidate = submission(141, undefined, {
    id: 'alias-backend-new',
    company: 'Alias Co',
    role: 'Sr Backend Engineer',
    url: 'https://jobs.example.com/alias-backend-141',
    employerJobId: 'alias:141',
    submittedAt: new Date().toISOString(),
  });

  const blocked = cliFailure(env, ['ledger', 'add', '--stdin'], candidate);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /NEW REQUISITION CONFIRMED/);
  const result = cli(env, ['ledger', 'add', '--stdin'], {
    ...candidate,
    duplicateOverride: 'NEW REQUISITION CONFIRMED',
  });
  assert.equal(result.recorded, 'alias-backend-new');
  const stored = (await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal('reapplicationApproval' in stored[1], false);
});

test('never permits hard duplicates even when both override phrases are supplied', async (t) => {
  const { env } = await fixture(t, 'hard-duplicates');
  const original = submission(150, undefined, {
    id: 'hard-original',
    company: 'Hard Duplicate Co',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.example.com/hard-original',
    employerJobId: 'hard:150',
    submittedAt: new Date(Date.now() - (30 * 86_400_000)).toISOString(),
  });
  cli(env, ['ledger', 'add', '--stdin'], original);
  const overrides = {
    duplicateOverride: 'NEW REQUISITION CONFIRMED',
    companyReapplyOverride: 'CANDIDATE APPROVED EARLY REAPPLICATION',
    submittedAt: new Date().toISOString(),
  };
  const candidates = [
    { ...submission(151, undefined), ...overrides, id: original.id, company: original.company },
    { ...submission(152, undefined), ...overrides, company: original.company, url: original.url },
    { ...submission(153, undefined), ...overrides, company: original.company, employerJobId: original.employerJobId },
  ];

  const messages = [/matching ledger ID/, /matching canonical URL/, /matching employer job ID or requisition/];
  for (const [index, candidate] of candidates.entries()) {
    const blocked = cliFailure(env, ['ledger', 'add', '--stdin'], candidate);
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /Hard duplicate blocked/);
    assert.match(blocked.stderr, messages[index]);
  }
});

test('serializes concurrent company writes so the cooldown cannot be bypassed', async (t) => {
  const { directory, env } = await fixture(t, 'concurrent-company-cooldown');
  cli(env, ['ledger', 'add', '--stdin'], submission(160, undefined, {
    id: 'concurrent-backend-role',
    company: 'Concurrent Co',
    role: 'Senior Backend Engineer',
    url: 'https://jobs.example.com/concurrent-backend-160',
    submittedAt: new Date(Date.now() - (16 * 86_400_000)).toISOString(),
  }));
  const first = submission(161, undefined, {
    id: 'concurrent-product-role',
    company: 'Concurrent Co',
    role: 'Staff Product Engineer',
    url: 'https://jobs.example.com/concurrent-product-161',
    submittedAt: new Date().toISOString(),
  });
  const second = submission(162, undefined, {
    id: 'concurrent-data-role',
    company: 'Concurrent Co',
    role: 'Principal Data Engineer',
    url: 'https://jobs.example.com/concurrent-data-162',
    submittedAt: new Date().toISOString(),
  });

  const results = await Promise.all([
    cliConcurrent(env, ['ledger', 'add', '--stdin'], first),
    cliConcurrent(env, ['ledger', 'add', '--stdin'], second),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [0, 1]);
  assert.match(results.find((result) => result.status === 1).stderr, /reapplication cooldown is active/i);
  const stored = (await readFile(join(directory, 'applications.ndjson'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(stored.length, 2);
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
