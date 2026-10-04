import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { writeInvite } from '../src/tester-invite.mjs';
import { issueInvite, redeemInvite, signIn, authenticate, signOut, workspaceEnv, hostingReady } from '../src/tester-access.mjs';
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

test('one invite creates one account; concurrent second redemption fails; real sign-in persists', async (t) => {
  const env = await testerEnv(t);
  const invite = issueInvite('new@example.test', env);
  const results = await Promise.allSettled([redeemInvite(invite.token, password, env), redeemInvite(invite.token, password, env)]);
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
  const expired = issueInvite('expired@example.test', env, { expiresAt: Date.now() - 1 });
  await assert.rejects(redeemInvite(expired.token, password, env));
});

test('tester profile, resume and ledger are isolated from the laptop and another tester', async (t) => {
  const env = await testerEnv(t);
  saveProfile({ ...sampleProfile, name: 'Laptop owner' }, sampleExtras, null, env);
  const first = await redeemInvite(issueInvite('first@example.test', env).token, password, env);
  const second = await redeemInvite(issueInvite('second@example.test', env).token, password, env);
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
  assert.equal(getProfile(env).profile.name, 'Laptop owner');
  await assert.rejects(importFromLocalSkill(a), /unavailable/);
  const entry = { id: 'test-job', company: 'Test', role: 'Engineer', url: 'https://example.test/job', source: 'greenhouse', status: 'submitted', submittedAt: new Date().toISOString(), score: 90, approval: 'STANDING AUTHORIZATION' };
  await ledgerAdd(entry, a);
  assert.equal((await ledgerCheck(entry, a)).duplicate, true);
  assert.equal((await ledgerCheck(entry, b)).duplicate, false);
  assert.equal(getProfile(env).resumePath, null);
});

test('tester submit capability requires redeemed membership and cannot widen beyond Greenhouse', async (t) => {
  const env = await testerEnv(t);
  const account = await redeemInvite(issueInvite('gate@example.test', env).token, password, env);
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
  const invite = issueInvite('http@example.test', env);
  assert.equal((await fetch(base + '/invite')).status, 200); // GET does not consume a link.
  assert.equal((await post('/api/redeem', { token: invite.token, password }, '', 'https://evil.test')).status, 403);
  assert.equal((await post('/api/redeem', { token: invite.token, password })).status, 201);
  assert.equal((await post('/api/redeem', { token: invite.token, password })).status, 409);
  const login = await post('/api/sign-in', { email: 'http@example.test', password });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  for (const path of ['/api/onboard/from-skill', '/api/applications/test/confirm', '/api/live-browser', '/api/lever', '/api/ashby']) {
    assert.equal((await post(path, {}, cookie)).status, 404);
  }
  const { autoSubmitMinScore, manualReviewMinScore, minMustHaveCoverage, ...formProfile } = sampleProfile;
  assert.equal((await post('/api/onboard', { profile: formProfile, extras: sampleExtras }, cookie)).status, 200);
  const status = await (await fetch(base + '/api/status', { headers: { cookie } })).json();
  assert.equal(status.profile.configured, true);
  assert.equal(status.profile.values.autoSubmitMinScore, 80);
  assert.equal(getProfile(env).configured, false);
  const other = await redeemInvite(issueInvite('other@example.test', env).token, password, env);
  saveProfile({ ...sampleProfile, name: 'Other private tester' }, sampleExtras, null, workspaceEnv(other.id, env));
  assert.doesNotMatch(JSON.stringify(status), /Other private tester/);
  const pdf = await fetch(base + '/api/resume', { method: 'POST', headers: { cookie, origin: env.CLOUD_TESTER_ORIGIN, 'content-type': 'application/pdf' }, body: '%PDF-1.4 test' });
  assert.equal(pdf.status, 200);
  assert.equal((await post('/api/rounds', { count: 2 }, cookie)).status, 202);
  const html = await (await fetch(base + '/workspace', { headers: { cookie } })).text();
  const script = await readFile(new URL('../src/tester-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html + script, /Lever|Ashby|live.browser|from-skill|laptop|127\.0\.0\.1/i);
  assert.match(html, /Greenhouse/);
  await post('/api/sign-out', {}, cookie);
  assert.equal((await fetch(base + '/api/status', { headers: { cookie } })).status, 401);
});

test('operator writes invitation to a private file and cannot overwrite it', async (t) => {
  const env = await testerEnv(t);
  const output = join(env.CLOUD_DATA_DIR, 'invite.txt');
  await writeInvite('file@example.test', output, env);
  const url = new URL((await readFile(output, 'utf8')).trim());
  assert.equal(url.pathname, '/invite');
  assert.equal(url.search, '');
  await redeemInvite(url.hash.slice(1), password, env);
  await assert.rejects(writeInvite('another@example.test', output, env));
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

test('unhosted tester server refuses invites, sign-in and workspace', async (t) => {
  const env = await testerEnv(t);
  delete env.CLOUD_TESTER_HOSTED;
  assert.throws(() => issueInvite('closed@example.test', env), /hosting/i);
  const server = startTesterServer(env, { embedWorker: false });
  const { port } = await server.ready;
  t.after(() => server.close());
  for (const path of ['/invite', '/workspace', '/api/status', '/sign-in']) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 503);
    assert.match(await response.text(), /not hosted/i);
  }
});
