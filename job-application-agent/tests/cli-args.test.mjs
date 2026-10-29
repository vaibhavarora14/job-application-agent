import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { COMMAND_USAGE, normalizeCliArgs, usageError, usageFor } from '../scripts/cli-args.mjs';
import { leadObservedAt } from '../scripts/application-accounting.mjs';

const script = fileURLToPath(new URL('../scripts/job-application.mjs', import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cli-args-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'telemetry.json'), JSON.stringify({ enabled: false, disclosed: true }));
  const env = { ...process.env, JOB_APPLICATION_AGENT_STATE_DIR: dir, JOB_APPLICATION_AGENT_CLOUD_CONFIG: join(dir, 'absent.json'), JOB_APPLICATION_AGENT_SOURCE_COMMUNITY_URL: 'http://127.0.0.1:9' };
  const cli = (args, input) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', input: input === undefined ? '' : JSON.stringify(input) });
  const ok = (args, input) => { const r = cli(args, input); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout); };
  return { dir, cli, ok };
}

test('normalizeCliArgs handles help, version, no-op flags, stdin aliases and inline JSON', () => {
  assert.equal(normalizeCliArgs([]).help, true);
  assert.equal(normalizeCliArgs(['--help']).help, true);
  assert.equal(normalizeCliArgs(['help', 'round']).help, 'round');
  assert.equal(normalizeCliArgs(['round', 'help']).help, 'round');
  assert.equal(normalizeCliArgs(['cloud', 'status', '--help']).help, 'cloud');
  assert.equal(normalizeCliArgs(['--version']).version, true);
  assert.deepEqual(normalizeCliArgs(['cloud', 'status', '--json']).args, ['cloud', 'status']);
  assert.deepEqual(normalizeCliArgs(['round', 'lead', '-']).args, ['round', 'lead', '--stdin']);
  assert.deepEqual(normalizeCliArgs(['cloud', 'lease', 'acquire']).args, ['cloud', 'lease-acquire']);
  assert.deepEqual(normalizeCliArgs(['cloud', 'intent', 'prepare', '--stdin']).args, ['cloud', 'intent-prepare', '--stdin']);
  assert.deepEqual(normalizeCliArgs(['profile', 'show']).args, ['profile', 'check']);
  assert.deepEqual(normalizeCliArgs(['profile', 'get', 'email']).args, ['profile', 'field', 'email']);
  const inline = normalizeCliArgs(['round', 'start', '{"requestedCount":2}']);
  assert.deepEqual(inline.args, ['round', 'start', '--stdin']);
  assert.deepEqual(inline.inlineJson, { requestedCount: 2 });
  // Documented forms are unchanged.
  assert.deepEqual(normalizeCliArgs(['round', 'lead', '--stdin']).args, ['round', 'lead', '--stdin']);
  assert.deepEqual(normalizeCliArgs(['sources', 'list']).args, ['sources', 'list']);
});

test('usage errors are area specific, keep the reason within the analytics bound, and never echo values', () => {
  const unknown = usageError(['bogus-area-with-user-text', 'x']).message;
  assert.match(unknown, /^Usage \(unknown area\)/);
  assert.doesNotMatch(unknown, /bogus-area-with-user-text/);
  const missingStdin = usageError(['round', 'lead']).message;
  assert.match(missingStdin.slice(0, 160), /^Usage \(round lead, missing --stdin\): Pipe one JSON object/);
  const unknownAction = usageError(['profile', 'secret-value@example.com']).message;
  assert.match(unknownAction, /^Usage \(profile, unknown subcommand\)/);
  assert.doesNotMatch(unknownAction, /secret-value/);
  assert.match(usageError(['cloud']).message, /^Usage \(cloud, missing subcommand\): cloud status/);
  // The fallback no longer looks like a cloud error for other areas.
  assert.doesNotMatch(usageError(['ledger', 'nope']).message, /cloud status/);
  assert.deepEqual(Object.keys(usageFor().usage).length, Object.keys(COMMAND_USAGE).length);
});

test('help and version exit 0 without touching state; usage errors stay nonzero', async (t) => {
  const { cli } = await fixture(t);
  for (const args of [[], ['help'], ['--help'], ['round', 'help'], ['cloud', '--help']]) {
    const result = cli(args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
    assert.ok(Array.isArray(JSON.parse(result.stdout).usage));
  }
  const version = cli(['--version']);
  assert.equal(version.status, 0, version.stderr);
  assert.match(version.stdout, /\d+\.\d+\.\d+/);
  const missing = cli(['round', 'lead']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Usage \(round lead, missing --stdin\)/);
  const bogus = cli(['bogus']);
  assert.notEqual(bogus.status, 0);
  assert.match(bogus.stderr, /Usage \(unknown area\)/);
});

test('inline JSON, "-" and --json work for stdin commands', async (t) => {
  const { cli, ok } = await fixture(t);
  const inline = cli(['round', 'start', JSON.stringify({ requestedCount: 2 })]);
  assert.equal(inline.status, 0, inline.stderr);
  assert.equal(JSON.parse(inline.stdout).requestedCount, 2);
  assert.equal(ok(['round', 'start', '-'], { requestedCount: 3 }).requestedCount, 3);
  assert.equal(ok(['cloud', 'status', '--json']).configured, false);
});

test('leadObservedAt defaults missing values and accepts ISO strings and epochs', () => {
  const now = new Date('2026-10-20T05:00:00.000Z');
  assert.equal(leadObservedAt(undefined, now), now.toISOString());
  assert.equal(leadObservedAt(null, now), now.toISOString());
  assert.equal(leadObservedAt('  ', now), now.toISOString());
  assert.equal(leadObservedAt('2026-10-19T10:49:00Z'), '2026-10-19T10:49:00.000Z');
  assert.equal(leadObservedAt(1792406940), '2026-10-19T10:49:00.000Z');
  assert.equal(leadObservedAt(1792406940000), '2026-10-19T10:49:00.000Z');
  for (const bad of ['yesterday', 'x'.repeat(81), -1, Number.NaN, true, {}]) {
    assert.throws(() => leadObservedAt(bad), /observedAt must be an ISO 8601 date-time/);
  }
});

test('round lead without observedAt is recorded; reporting counts before leads explains the recorded totals', async (t) => {
  const { cli, ok } = await fixture(t);
  const { roundId } = ok(['round', 'start', '--stdin'], { requestedCount: 1 });
  const early = cli(['round', 'source', '--stdin'], { roundId, sourceId: 'indeed', status: 'searched', reviewedCount: 2, qualifiedCount: 1, evidence: 'Synthetic search.' });
  assert.notEqual(early.status, 0);
  assert.match(early.stderr, /Source count assertions do not match recorded leads \(recorded for this source: reviewed 0, qualified 0\)\. Record every reviewed lead/);
  const lead = { roundId, sourceId: 'indeed', url: 'https://example.test/jobs/1', company: 'Example', disposition: 'qualified', evidence: 'Synthetic qualifying posting.' };
  const recorded = ok(['round', 'lead', '--stdin'], lead);
  assert.ok(Number.isFinite(Date.parse(recorded.event.observedAt)));
  ok(['round', 'lead', '--stdin'], { ...lead, url: 'https://example.test/jobs/2', disposition: 'seniority-mismatch', observedAt: null });
  const source = ok(['round', 'source', '--stdin'], { roundId, sourceId: 'indeed', status: 'searched', evidence: 'Synthetic search.' });
  assert.equal(source.reviewedCount, 2);
  assert.equal(source.qualifiedCount, 1);
  // Matching assertions remain accepted.
  assert.equal(ok(['round', 'source', '--stdin'], { roundId, sourceId: 'indeed', status: 'searched', reviewedCount: 2, qualifiedCount: 1, evidence: 'Synthetic search.' }).reviewedCount, 2);
});

test('prototype property names remain unknown CLI tokens rather than aliases', () => {
  for (const token of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.deepEqual(normalizeCliArgs(['profile', token]).args, ['profile', token]);
    assert.deepEqual(normalizeCliArgs([token, 'constructor']).args, [token, 'constructor']);
    assert.deepEqual(normalizeCliArgs([token, 'constructor', '{}']).args, [token, 'constructor', '--stdin']);
    assert.deepEqual(usageFor(token), usageFor());
    assert.match(usageError(['profile', token]).message, /^Usage \(profile, unknown subcommand\)/);
  }
});
