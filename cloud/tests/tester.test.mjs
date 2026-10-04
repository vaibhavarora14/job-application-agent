import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readFile, writeFile, stat, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { writeJoinLink } from '../src/tester-join.mjs';
import { joinUrl, joinAvailable, registerTester, signIn, authenticate, signOut, workspaceEnv, hostingReady } from '../src/tester-access.mjs';
import { getProfile, saveProfile, storeResume, ledgerAdd, ledgerCheck, importFromLocalSkill } from '../src/skill.mjs';
import { startTesterServer } from '../src/tester-server.mjs';
import { evaluateSubmitGate } from '../src/apply/gate.mjs';
import { isolatedEnv, sampleProfile, sampleExtras } from './helpers.mjs';

const password = 'test-only-long-password';
export async function testerEnv(t) {
  const env = await isolatedEnv(t);
  return { ...env, CLOUD_TESTER_DATA_DIR: join(env.CLOUD_DATA_DIR, 'testers'), CLOUD_TESTER_ORIGIN: 'https://invites.example.test', CLOUD_TESTER_HOSTED: '1' };
}

test('hosting fails closed without explicitly configured remote HTTPS hosting', () => {
  for (const origin of ['', 'http://test.example', 'https://127.0.0.1', 'https://localhost', 'https://[::1]']) {
    assert.equal(hostingReady({ CLOUD_TESTER_HOSTED: '1', CLOUD_TESTER_ORIGIN: origin, CLOUD_TESTER_DATA_DIR: '/tmp/test' }), false);
  }
  assert.equal(hostingReady({}), false);
  const flyEnv = {
    CLOUD_TESTER_ORIGIN: 'https://jobappagent-cloud-tester.fly.dev',
    CLOUD_TESTER_DATA_DIR: '/private/tester-data',
  };
  assert.equal(hostingReady(flyEnv), false);
  assert.equal(hostingReady({ ...flyEnv, CLOUD_TESTER_HOSTED: '1' }), true);
  assert.equal(hostingReady({ ...flyEnv, CLOUD_TESTER_HOSTED: '1', CLOUD_TESTER_DATA_DIR: 'relative' }), false);
  assert.equal(hostingReady({ ...flyEnv, CLOUD_TESTER_HOSTED: '1', CLOUD_TESTER_ORIGIN: `${flyEnv.CLOUD_TESTER_ORIGIN}/` }), false);
});

test('duplicate sign-ups create one account; real sign-in persists', async (t) => {
  const env = await testerEnv(t);
  const results = await Promise.allSettled([registerTester('new@example.test', password, env), registerTester('new@example.test', password, env)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  await assert.rejects(signIn('new@example.test', 'incorrect-password', env));
  await assert.rejects(signIn('uninvited@example.test', password, env));
  const session = await signIn('new@example.test', password, { ...env });
  assert.equal(authenticate(session.token, env).email, 'new@example.test');
  signOut(session.token, env);
  assert.equal(authenticate(session.token, env), null);
  const timedOut = await signIn('new@example.test', password, env);
  const db = new DatabaseSync(join(env.CLOUD_TESTER_DATA_DIR, 'access.sqlite'));
  db.prepare('UPDATE sessions SET expires = 0').run();
  db.close();
  assert.equal(authenticate(timedOut.token, env), null);
});

test('tester profile, resume and ledger are isolated from the laptop and another tester', async (t) => {
  const env = await testerEnv(t);
  saveProfile({ ...sampleProfile, name: 'Laptop owner' }, sampleExtras, null, env);
  const first = await registerTester('first@example.test', password, env);
  const second = await registerTester('second@example.test', password, env);
  const a = workspaceEnv(first.id, env);
  const b = workspaceEnv(second.id, env);
  assert.notEqual(a.JOB_APPLICATION_AGENT_STATE_DIR, env.JOB_APPLICATION_AGENT_STATE_DIR);
  assert.equal(getProfile(a).configured, false);
  saveProfile({ ...sampleProfile, name: 'First tester' }, sampleExtras, null, a);
  const pdf = join(env.CLOUD_DATA_DIR, 'fixture.pdf');
  await writeFile(pdf, '%PDF-1.4 test');
  await storeResume(pdf, a);
  assert.match(getProfile(a).resumePath, /testers.*workspaces/);
  assert.equal(getProfile(b).configured, false);
  assert.equal(Boolean(getProfile(b).resumePath), false);
  assert.equal(getProfile(env).profile.name, 'Laptop owner');
  await assert.rejects(importFromLocalSkill(a), /unavailable/);
  const entry = { id: 'test-job', company: 'Test', role: 'Engineer', url: 'https://example.test/job', source: 'greenhouse', status: 'submitted', submittedAt: new Date().toISOString(), score: 90, approval: 'STANDING AUTHORIZATION' };
  await ledgerAdd(entry, a);
  assert.equal((await ledgerCheck(entry, a)).duplicate, true);
  assert.equal((await ledgerCheck(entry, b)).duplicate, false);
  assert.equal(getProfile(env).resumePath, null);
});

test('tester submit capability requires registered membership and cannot widen beyond Greenhouse', async (t) => {
  const env = await testerEnv(t);
  const account = await registerTester('gate@example.test', password, env);
  const scoped = workspaceEnv(account.id, env);
  const input = { submissionMode: 'routine-auto', ledgerClean: true, decision: 'review', autoEligible: true, requiredFilled: true, resumeAttached: true, env: scoped };
  assert.equal(evaluateSubmitGate({ ...input, channel: 'greenhouse' }).ok, true);
  for (const channel of ['lever', 'ashby']) assert.equal(evaluateSubmitGate({ ...input, channel }).ok, false);
  assert.throws(() => workspaceEnv('candidate-001', env));
  assert.equal(evaluateSubmitGate({ ...input, env, channel: 'greenhouse' }).ok, false);
});

test('tester HTTP surface enforces auth, origin, isolation and no operator/stub routes', async (t) => {
  const env = await testerEnv(t);
  const server = startTesterServer(env, { embedWorker: false });
  const { port } = await server.ready;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, cookie = '', origin = env.CLOUD_TESTER_ORIGIN) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', origin, cookie }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/status')).status, 401);
  assert.equal((await post('/api/signup', {})).status, 401);
  assert.equal((await fetch(base + '/join')).status, 200); // GET does not consume a link.
  assert.equal((await post('/api/join', { email: 'http@example.test', password }, '', 'https://evil.test')).status, 403);
  assert.equal((await post('/api/join', { email: 'http@example.test', password })).status, 201);
  assert.equal((await post('/api/join', { email: 'http@example.test', password })).status, 409);
  const login = await post('/api/sign-in', { email: 'http@example.test', password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const path of ['/api/onboard/from-skill', '/api/applications/test/confirm', '/api/live-browser', '/api/lever', '/api/ashby', '/api/redeem']) {
    assert.equal((await post(path, {}, cookie)).status, 404);
  }
  const { autoSubmitMinScore, manualReviewMinScore, minMustHaveCoverage, ...formProfile } = sampleProfile;
  assert.equal((await post('/api/onboard', { profile: formProfile, extras: sampleExtras }, cookie)).status, 200);
  const status = await (await fetch(base + '/api/status', { headers: { cookie } })).json();
  assert.equal(status.profile.configured, true);
  assert.equal(status.profile.values.autoSubmitMinScore, 80);
  assert.equal(getProfile(env).configured, false);
  const other = await registerTester('other@example.test', password, env);
  saveProfile({ ...sampleProfile, name: 'Other private tester' }, sampleExtras, null, workspaceEnv(other.id, env));
  const ownStatus = await (await fetch(base + `/api/status?account_id=${other.id}`, { headers: { cookie } })).json();
  assert.doesNotMatch(JSON.stringify(ownStatus), /Other private tester/);
  const pdf = await fetch(base + '/api/resume', { method: 'POST', headers: { cookie, origin: env.CLOUD_TESTER_ORIGIN, 'content-type': 'application/pdf' }, body: '%PDF-1.4 test' });
  assert.equal(pdf.status, 200);
  const ownAccount = authenticate(cookie.slice(cookie.indexOf('=') + 1), env);
  const ownScope = workspaceEnv(ownAccount.id, env);
  await ledgerAdd({ id: 'private-entry', company: 'Private company', role: 'Engineer', url: 'https://example.test/private-job', source: 'greenhouse', status: 'submitted', submittedAt: new Date().toISOString(), score: 90, approval: 'STANDING AUTHORIZATION' }, ownScope);
  const otherLogin = await post('/api/sign-in', { email: 'other@example.test', password });
  const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0];
  assert.notEqual(otherCookie, cookie);
  const otherStatus = await (await fetch(base + `/api/status?account_id=${ownAccount.id}`, { headers: { cookie: otherCookie } })).json();
  assert.equal(otherStatus.profile.values.name, 'Other private tester');
  assert.equal(otherStatus.profile.resume, false);
  assert.deepEqual(otherStatus.ledger, []);
  assert.equal((await fetch(base + `/workspaces/${ownAccount.id}/resume.pdf`, { headers: { cookie: otherCookie } })).status, 404);

  assert.equal((await post('/api/rounds', { count: 2 }, cookie)).status, 202);
  const html = await (await fetch(base + '/workspace', { headers: { cookie } })).text();
  const script = await readFile(new URL('../src/tester-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html + script, /Lever|Ashby|live.browser|from-skill|laptop|127\.0\.0\.1/i);
  assert.match(html, /Greenhouse/);
  await post('/api/sign-out', {}, cookie);
  assert.equal((await fetch(base + '/api/status', { headers: { cookie } })).status, 401);
  assert.equal((await fetch(base + '/api/status', { headers: { cookie: otherCookie } })).status, 200);
});

test('operator writes the same stable join URL to private files without overwriting', async (t) => {
  const env = await testerEnv(t);
  const output = join(env.CLOUD_DATA_DIR, 'join.txt');
  await writeJoinLink(output, env);
  assert.equal((await readFile(output, 'utf8')).trim(), `${env.CLOUD_TESTER_ORIGIN}/join`);
  assert.equal(joinUrl({ ...env }), joinUrl(env));
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const secondOutput = join(env.CLOUD_DATA_DIR, 'join-again.txt');
  const result = await promisify(execFile)(process.execPath, [new URL('../src/tester-join.mjs', import.meta.url).pathname, secondOutput], { env });
  assert.equal(await readFile(secondOutput, 'utf8'), await readFile(output, 'utf8'));
  assert.doesNotMatch(result.stdout + result.stderr, /https:|password|token/i);
  await assert.rejects(writeJoinLink(output, env));
});

test('only completed new sign-ups count: account 25 succeeds, 26 gets closed and no account', async (t) => {
  const env = await testerEnv(t);
  const server = startTesterServer(env, { embedWorker: false });
  const { port } = await server.ready;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 30; i++) assert.equal((await fetch(base + '/join')).status, 200);
  await assert.rejects(registerTester('invalid', password, env));
  await assert.rejects(registerTester('short@example.test', 'short', env));
  for (let i = 1; i <= 24; i++) await registerTester(`tester${i}@example.test`, password, env);
  await assert.rejects(registerTester(' TESTER1@example.test ', password, env));
  const post = email => fetch(base + '/api/join', { method: 'POST', headers: { origin: env.CLOUD_TESTER_ORIGIN }, body: JSON.stringify({ email, password }) });
  assert.equal((await post('tester25@example.test')).status, 201);
  const closed = await post('tester26@example.test');
  assert.equal(closed.status, 409);
  assert.match((await closed.json()).error, /closed.*25/i);
  assert.equal(closed.headers.get('set-cookie'), null);
  await assert.rejects(signIn('tester26@example.test', password, env));
  const session = await signIn('tester25@example.test', password, env);
  assert.equal(authenticate(session.token, env).email, 'tester25@example.test');
  const db = new DatabaseSync(join(env.CLOUD_TESTER_DATA_DIR, 'access.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n, 25);
  const rows = db.prepare('SELECT salt, password_hash FROM accounts').all();
  assert.equal(new Set(rows.map(row => row.salt)).size, 25);
  assert.ok(rows.every(row => row.password_hash.length === 128 && row.password_hash !== password));
  db.exec('UPDATE accounts SET active = 0');
  db.close();
  await assert.rejects(registerTester('later@example.test', password, { ...env }), /closed/i);
  const removedDb = new DatabaseSync(join(env.CLOUD_TESTER_DATA_DIR, 'access.sqlite'));
  removedDb.exec('DELETE FROM accounts');
  removedDb.close();
  await assert.rejects(registerTester('removed@example.test', password, { ...env }), /closed/i);
  assert.equal((await (await fetch(base + '/api/join')).json()).open, false);
});

test('concurrent processes cannot both take the last place', async (t) => {
  const env = await testerEnv(t);
  for (let i = 0; i < 24; i++) await registerTester(`tester${i}@example.test`, password, env);
  const script = `
    const { registerTester } = await import(${JSON.stringify(new URL('../src/tester-access.mjs', import.meta.url).href)});
    try {
      await registerTester(process.argv[1], 'test-only-long-password', process.env);
      console.log('admitted');
    } catch (error) {
      if (error.cause !== 'join-closed') throw error;
      console.log('closed');
    }
  `;
  const results = await Promise.all(['a', 'b'].map(name => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, `${name}@example.test`], { env })));
  assert.deepEqual(results.map(result => result.stdout.trim()).sort(), ['admitted', 'closed']);
  assert.equal(joinAvailable({ ...env }), false);
});

test('existing invited membership and sessions survive without consuming join places', async (t) => {
  const env = await testerEnv(t);
  const account = await registerTester('existing@example.test', password, env);
  const session = await signIn(account.email, password, env);
  const db = new DatabaseSync(join(env.CLOUD_TESTER_DATA_DIR, 'access.sqlite'));
  // Reconstruct the previous schema's redeemed membership, with no join record.
  db.prepare('INSERT INTO invites VALUES (?, ?, ?, ?)').run('legacy-digest', account.email, 0, account.id);
  db.exec('DROP TABLE join_registrations');
  db.close();
  assert.equal(authenticate(session.token, { ...env }).id, account.id);
  assert.ok(workspaceEnv(account.id, env));
  for (let i = 0; i < 25; i++) await registerTester(`new${i}@example.test`, password, env);
  assert.equal(joinAvailable(env), false);
  assert.equal(authenticate(session.token, env).id, account.id);
});

test('authentication attempts are limited without revealing account existence', async (t) => {
  const env = await testerEnv(t);
  const server = startTesterServer(env, { embedWorker: false });
  const { port } = await server.ready;
  t.after(() => server.close());
  for (let i = 0; i < 11; i++) {
    const response = await fetch(`http://127.0.0.1:${port}/api/sign-in`, { method: 'POST', headers: { origin: env.CLOUD_TESTER_ORIGIN }, body: JSON.stringify({ email: 'unknown@example.test', password }) });
    assert.equal(response.status, i < 10 ? 401 : 429);
  }
});

test('unhosted tester server refuses join, sign-in and workspace', async (t) => {
  const env = await testerEnv(t);
  delete env.CLOUD_TESTER_HOSTED;
  assert.throws(() => joinUrl(env), /hosting/i);
  await assert.rejects(registerTester('closed@example.test', password, env), /hosting/i);
  const server = startTesterServer(env, { embedWorker: false });
  const { port } = await server.ready;
  t.after(() => server.close());
  for (const path of ['/join', '/api/join', '/workspace', '/api/status', '/sign-in']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /not hosted/i);
  }
  for (const path of ['/api/join', '/api/sign-in']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { origin: env.CLOUD_TESTER_ORIGIN }, body: JSON.stringify({ email: 'closed@example.test', password }) });
    assert.equal(response.status, 503);
  }
  await assert.rejects(access(env.CLOUD_TESTER_DATA_DIR));
});
