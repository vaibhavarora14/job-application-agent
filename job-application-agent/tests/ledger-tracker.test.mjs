import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeCliArgs } from '../scripts/cli-args.mjs';
import { buildReview, terminalPlain, trackerStatusFor } from '../scripts/job-application.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

function entry(overrides) {
  return {
    id: 'web-1',
    company: 'Acme',
    role: 'Engineer',
    url: 'https://jobs.example.com/web',
    source: 'company',
    score: 90,
    status: 'submitted',
    submittedAt: '2026-03-01T00:00:00.000Z',
    approval: 'APPROVE SUBMIT',
    answers: {},
    ...overrides,
  };
}

async function fixture(t, { telemetry = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ledger-tracker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'telemetry.json'), JSON.stringify({
    version: 1,
    enabled: telemetry,
    disclosed: true,
    graceConsumed: true,
    installationEventPending: false,
    contactEnabled: false,
    contactDisclosed: true,
  }));
  const env = {
    ...process.env,
    JOB_APPLICATION_AGENT_STATE_DIR: directory,
    JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(directory, 'absent-cloud.json'),
    JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9',
    JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE: `com.vaibhavarora.job-application-agent.test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  };
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: 'utf8',
    input: input === undefined ? '' : JSON.stringify(input),
  });
  return { directory, env, run };
}

async function seed(directory, rows) {
  await writeFile(join(directory, 'applications.ndjson'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

test('terminalPlain removes ANSI and C0 controls from company and role text', () => {
  assert.equal(terminalPlain('Acme\u001b[31m Corp\u0007'), 'Acme Corp');
  assert.equal(terminalPlain('Staff\nEngineer\u001b]0;title\u0007'), 'StaffEngineer');
  assert.equal(terminalPlain('ok'), 'ok');
});

test('tracker status rolls outcomes up and keeps unconfirmed email as submitted', () => {
  const confirmed = { counted: true, receiptUnknown: false, failed: false, conflict: false };
  const unconfirmed = { counted: true, receiptUnknown: true, failed: false, conflict: false };
  const web = entry({ id: 'web-1' });
  assert.equal(trackerStatusFor(web, [], confirmed), 'confirmed');
  assert.equal(trackerStatusFor(entry({ id: 'mail-1', source: 'email' }), [], unconfirmed), 'submitted');
  assert.equal(trackerStatusFor(entry({ id: 'draft-1', status: 'drafted' }), [], confirmed), 'drafted');
  assert.equal(trackerStatusFor(web, [{ id: 'web-1', status: 'rejected', occurredAt: '2026-04-01T00:00:00.000Z' }], confirmed), 'response');
  assert.equal(trackerStatusFor(web, [
    { id: 'web-1', status: 'interview', occurredAt: '2026-04-01T00:00:00.000Z' },
    { id: 'web-1', status: 'closed', occurredAt: '2026-05-01T00:00:00.000Z' },
  ], confirmed), 'closed');
  assert.equal(trackerStatusFor(web, [{ id: 'other', status: 'offer', occurredAt: '2026-05-01T00:00:00.000Z' }], confirmed), 'confirmed');
  assert.equal(trackerStatusFor(web, [{ id: 'web-1', status: 'withdrawn', occurredAt: '2026-05-01T00:00:00.000Z' }], confirmed), 'closed');
  assert.equal(trackerStatusFor(entry({ id: 'mail-1', source: 'email' }), [], { counted: false, receiptUnknown: false, failed: true, conflict: false }), 'closed');
});

test('a tracker-only outcome does not drop legacy review counts', () => {
  const legacy = {
    id: 'legacy-1', company: 'Legacy Co', role: 'Engineer', url: 'https://jobs.example.com/legacy',
    status: 'interview', submittedAt: '2026-01-01T00:00:00.000Z', source: 'company', score: 80,
  };
  const current = {
    id: 'current-1', company: 'Current Co', role: 'Engineer', url: 'https://jobs.example.com/current',
    status: 'submitted', submittedAt: '2026-02-01T00:00:00.000Z', source: 'company', score: 80,
  };
  const review = buildReview([legacy, current], [{ id: 'current-1', status: 'response', occurredAt: '2026-03-01T00:00:00.000Z' }]);
  assert.equal(review.outcomeCounts.interview, 1);
  const sameRow = buildReview([legacy], [{ id: 'legacy-1', status: 'closed', occurredAt: '2026-03-02T00:00:00.000Z' }]);
  assert.equal(sameRow.outcomeCounts.interview, 1);
});

test('ledger list keeps --json and prints status plus date for every ledger row', async (t) => {
  assert.deepEqual(
    normalizeCliArgs(['ledger', 'list', '--status', 'confirmed', '--json']).args,
    ['ledger', 'list', '--status', 'confirmed', '--json'],
  );
  assert.deepEqual(normalizeCliArgs(['cloud', 'status', '--json']).args, ['cloud', 'status']);

  const { directory, run } = await fixture(t);
  await seed(directory, [
    entry({
      company: 'Acme\u001b[31m Corp\u0007',
      role: 'Staff\nEngineer',
    }),
    entry({
      id: 'mail-1',
      company: 'MailCo',
      role: 'Writer',
      url: 'https://jobs.example.com/mail',
      source: 'email',
      applicationChannel: 'email',
      submittedAt: '2026-02-01T00:00:00.000Z',
    }),
    entry({
      id: 'draft-1',
      company: 'DraftCo',
      role: 'Intern',
      url: 'https://jobs.example.com/draft',
      status: 'drafted',
      submittedAt: '2026-01-01T00:00:00.000Z',
    }),
  ]);

  const text = run(['ledger', 'list']);
  assert.equal(text.status, 0, text.stderr);
  assert.deepEqual(text.stdout.trim().split('\n'), [
    'confirmed\t2026-03-01T00:00:00.000Z\tAcme Corp\tStaffEngineer\tweb-1',
    'submitted\t2026-02-01T00:00:00.000Z\tMailCo\tWriter\tmail-1',
    'drafted\t2026-01-01T00:00:00.000Z\tDraftCo\tIntern\tdraft-1',
  ]);
  assert.equal(text.stdout.includes('\u001b'), false);
  assert.equal(text.stdout.includes('Staff\nEngineer'), false);

  const json = run(['ledger', 'list', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.count, 3);
  assert.equal(body.entries[0].company, 'Acme Corp');
  assert.equal(body.entries[0].role, 'StaffEngineer');
  assert.equal(body.entries[0].status, 'confirmed');
  assert.equal(body.entries[0].date, '2026-03-01T00:00:00.000Z');
  assert.equal(body.entries[0].url, 'https://jobs.example.com/web');
  assert.equal(JSON.stringify(body).includes('\u001b'), false);
});

test('ledger list filters by tracker status and company together', async (t) => {
  const { directory, run } = await fixture(t);
  await seed(directory, [
    entry(),
    entry({ id: 'mail-1', company: 'MailCo', role: 'Writer', url: 'https://jobs.example.com/mail', source: 'email', applicationChannel: 'email' }),
    entry({ id: 'other-1', company: 'Other', role: 'Designer', url: 'https://jobs.example.com/other' }),
  ]);
  const filtered = run(['ledger', 'list', '--status', 'CONFIRMED', '--company', 'acme', '--json']);
  assert.equal(filtered.status, 0, filtered.stderr);
  const body = JSON.parse(filtered.stdout);
  assert.deepEqual(body.entries.map((row) => row.id), ['web-1']);

  const none = run(['ledger', 'list', '--status', 'response', '--json']);
  assert.equal(none.status, 0, none.stderr);
  assert.equal(JSON.parse(none.stdout).count, 0);

  const invalid = run(['ledger', 'list', '--status', 'nope']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Invalid tracker status/);
  assert.doesNotMatch(invalid.stderr, /nope/);
});

test('ledger outcome by id or url stores a local timestamped outcome and list shows it', async (t) => {
  const { directory, run } = await fixture(t);
  await seed(directory, [
    entry(),
    entry({ id: 'mail-1', company: 'MailCo', role: 'Writer', url: 'https://jobs.example.com/mail?ref=friend', source: 'email', applicationChannel: 'email' }),
  ]);
  const before = Date.now();
  const logged = run(['ledger', 'outcome', 'web-1', '--status', 'rejected', '--note', 'No visa\u001b[0m']);
  assert.equal(logged.status, 0, logged.stderr);
  const outcome = JSON.parse(logged.stdout);
  assert.equal(outcome.recorded, true);
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.recordedOutcome, 'web-1');
  assert.ok(Math.abs(Date.parse(outcome.occurredAt) - before) < 60_000);
  assert.equal(logged.stdout.includes('No visa'), false);
  assert.equal(logged.stdout.includes('Acme'), false);
  assert.equal(logged.stdout.includes('jobs.example.com'), false);

  const rows = (await readFile(join(directory, 'outcomes.ndjson'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'web-1');
  assert.equal(rows[0].status, 'rejected');
  assert.equal(rows[0].note, 'No visa');
  assert.equal(rows[0].occurredAt, outcome.occurredAt);
  assert.equal(rows[0].note.includes('\u001b'), false);

  const listed = JSON.parse(run(['ledger', 'list', '--status', 'response', '--json']).stdout);
  assert.deepEqual(listed.entries.map((row) => row.id), ['web-1']);
  assert.equal(listed.entries[0].date, outcome.occurredAt);

  const byUrl = run(['ledger', 'outcome', 'https://jobs.example.com/mail', '--status', 'closed', '--note', 'role filled']);
  assert.equal(byUrl.status, 0, byUrl.stderr);
  assert.equal(JSON.parse(byUrl.stdout).status, 'closed');
  const closed = JSON.parse(run(['ledger', 'list', '--company', 'mailco', '--json']).stdout);
  assert.equal(closed.entries[0].status, 'closed');
  assert.equal(closed.entries[0].id, 'mail-1');
});

test('ledger outcome flag form does not emit company, role, notes, or URLs', async (t) => {
  const { directory, run } = await fixture(t, { telemetry: true });
  await seed(directory, [entry({ company: 'SecretCo', role: 'Private Role', url: 'https://jobs.example.com/secret-role' })]);
  const logged = run(['ledger', 'outcome', 'web-1', '--status', 'interview', '--note', 'onsite loop']);
  assert.equal(logged.status, 0, logged.stderr);
  const queued = await readFile(join(directory, 'telemetry-queue.ndjson'), 'utf8').catch(() => '');
  const quarantined = await readFile(join(directory, 'telemetry-quarantine.ndjson'), 'utf8').catch(() => '');
  const combined = `${queued}\n${quarantined}`;
  assert.equal(combined.includes('outcome_recorded'), false);
  assert.equal(combined.includes('SecretCo'), false);
  assert.equal(combined.includes('Private Role'), false);
  assert.equal(combined.includes('onsite loop'), false);
  assert.equal(combined.includes('jobs.example.com'), false);
  assert.match(queued, /command_completed/);
});

test('structured ledger outcome --stdin still records and the flag form rejects unknown targets', async (t) => {
  const { directory, run } = await fixture(t);
  await seed(directory, [entry()]);
  const stdin = run(['ledger', 'outcome', '--stdin'], { id: 'web-1', status: 'withdrawn', occurredAt: '2026-04-02T00:00:00.000Z' });
  assert.equal(stdin.status, 0, stdin.stderr);
  assert.equal(JSON.parse(stdin.stdout).recorded, true);
  const listed = JSON.parse(run(['ledger', 'list', '--json']).stdout);
  assert.equal(listed.entries[0].status, 'closed');

  const missing = run(['ledger', 'outcome', 'https://jobs.example.com/not-in-ledger', '--status', 'offer', '--note', 'private note']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /No ledger entry matches/);
  assert.doesNotMatch(missing.stderr, /not-in-ledger/);
  assert.doesNotMatch(missing.stderr, /private note/);
  assert.doesNotMatch(missing.stderr, /jobs\.example\.com/);

  const badStatus = run(['ledger', 'outcome', 'web-1', '--status', 'withdrawn']);
  assert.notEqual(badStatus.status, 0);
  assert.match(badStatus.stderr, /Invalid outcome status/);
  const stored = (await readFile(join(directory, 'outcomes.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(stored.length, 1);
});
