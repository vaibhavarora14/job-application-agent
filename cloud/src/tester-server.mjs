import { createServer } from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { allowAuthAttempt, authenticate, hostingReady, registerTester, joinAvailable, JOIN_CLOSED, signIn, signOut, testerAccounts, workspaceEnv } from './tester-access.mjs';
import { ensureDataDirs, skillStateDir } from './paths.mjs';
import { extrasFromBody, getProfile, saveProfile, storeResume } from './skill.mjs';
import { openDb } from './db.mjs';
import { startRound } from './round.mjs';
import { drainOnce } from './worker.mjs';

const cookieName = '__Host-tester';
const cookieValue = token => `${cookieName}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token ? 43200 : 0}`;
const tokenFrom = req => String(req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';

export function startTesterServer(env = process.env, { embedWorker = true } = {}) {
  const server = createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    handle(req, res, env).catch(() => json(res, 400, { error: 'Request could not be completed.' }));
  });
  const ready = new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(env.PORT || 8788), env.HOST || '127.0.0.1', () => resolve({ port: server.address().port }));
  });
  let running = false;
  let pending = Promise.resolve();
  const timer = embedWorker && hostingReady(env) ? setInterval(() => {
    if (running) return;
    running = true;
    pending = (async () => {
      for (const { id } of testerAccounts(env)) await drainOnce(workspaceEnv(id, env));
    })().catch(() => {}).finally(() => { running = false; });
  }, 1500) : null;
  timer?.unref();
  return { ready, close: async () => { clearInterval(timer); await pending; await new Promise(resolve => server.close(resolve)); } };
}

async function handle(req, res, env) {
  if (!hostingReady(env)) return json(res, 503, { error: 'Tester workspace is not hosted. Sign-up, sign-in and submission are closed until a separately authorized HTTPS deployment exists.' });
  const path = new URL(req.url, 'http://request.invalid').pathname;
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { error: 'Method unavailable.' });
  if (req.method === 'POST' && req.headers.origin !== env.CLOUD_TESTER_ORIGIN) return json(res, 403, { error: 'Origin rejected.' });
  if (req.method === 'GET' && ['/join', '/sign-in', '/tester-ui.js', '/tester.css'].includes(path)) return asset(res, path);
  if (req.method === 'GET' && path === '/api/join') return json(res, 200, { open: joinAvailable(env), closedMessage: JOIN_CLOSED });
  if (req.method === 'POST' && path === '/api/join' && !joinAvailable(env)) return json(res, 409, { error: JOIN_CLOSED });
  if (req.method === 'POST' && ['/api/join', '/api/sign-in'].includes(path)) {
    const body = JSON.parse((await readBody(req, 4096)).toString());
    if (!allowAuthAttempt(`ip:${req.socket.remoteAddress}`, env) || !allowAuthAttempt(`identity:${String(body.email || '').trim().toLowerCase()}`, env)) return json(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    if (path === '/api/join') {
      try {
        await registerTester(body.email, body.password, env);
        return json(res, 201, { ok: true });
      } catch (error) { return json(res, 409, { error: error.cause === 'join-closed' ? JOIN_CLOSED : 'Sign-up unavailable. Use a new email and a password of 12–128 characters.' }); }
    }
    try {
      const session = await signIn(body.email, body.password, env);
      res.setHeader('set-cookie', cookieValue(session.token));
      return json(res, 200, { ok: true });
    } catch { return json(res, 401, { error: 'Invalid sign-in.' }); }
  }
  const token = tokenFrom(req);
  const account = authenticate(token, env);
  if (!account) return json(res, 401, { error: 'Sign in with your tester account at /sign-in.' });
  if (req.method === 'GET' && ['/', '/workspace'].includes(path)) return asset(res, '/workspace');
  if (req.method === 'POST' && path === '/api/sign-out') {
    signOut(token, env);
    res.setHeader('set-cookie', cookieValue(''));
    return json(res, 200, { ok: true });
  }
  // Deliberate route allowlist: no operator API, imports, manual confirmations or arbitrary URLs.
  const scope = workspaceEnv(account.id, env);
  if (req.method === 'GET' && path === '/api/status') {
    const profile = getProfile(scope);
    const db = openDb(scope);
    const applications = db.prepare(`SELECT a.company, a.role, a.status FROM applications a JOIN jobs j ON j.id = a.job_id WHERE j.application_channel = 'greenhouse' ORDER BY a.updated_at DESC`).all();
    const ledger = db.prepare('SELECT json FROM tester_ledger').all().map(row => JSON.parse(row.json));
    return json(res, 200, { email: account.email, profile: { configured: profile.configured, resume: Boolean(profile.resumePath), values: profile.profile, extras: profile.extras }, applications, ledger });
  }
  if (req.method === 'POST' && path === '/api/onboard') {
    const body = JSON.parse((await readBody(req, 64000)).toString());
    const saved = saveProfile({ ...body.profile, autoSubmitMinScore: 80, manualReviewMinScore: 70, minMustHaveCoverage: 70 }, extrasFromBody(body.extras), null, scope);
    return json(res, 200, { configured: saved.configured, missing: saved.missing });
  }
  if (req.method === 'POST' && path === '/api/resume') {
    if (!getProfile(scope).configured) return json(res, 409, { error: 'Save your profile first.' });
    const bytes = await readBody(req, 5 * 1024 * 1024);
    if (req.headers['content-type'] !== 'application/pdf' || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) return json(res, 400, { error: 'Upload a PDF, up to 5 MB.' });
    ensureDataDirs(scope);
    const temp = join(skillStateDir(scope), `upload-${randomUUID()}.pdf`);
    await writeFile(temp, bytes, { mode: 0o600, flag: 'wx' });
    try { await storeResume(temp, scope); } finally { await unlink(temp); }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && path === '/api/rounds') {
    const profile = getProfile(scope);
    if (!profile.configured || !profile.resumePath) return json(res, 409, { error: 'Save your profile and upload your résumé first.' });
    const body = JSON.parse((await readBody(req, 1024)).toString());
    return json(res, 202, startRound(body.count, scope));
  }
  return json(res, 404, { error: 'Unavailable.' });
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Body too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function asset(res, path) {
  const file = path === '/tester-ui.js' ? ['tester-ui.js', 'text/javascript'] : path === '/tester.css' ? ['tester.css', 'text/css'] : ['tester-ui.html', 'text/html'];
  const body = await readFile(new URL(file[0], import.meta.url));
  res.writeHead(200, { 'content-type': `${file[1]}; charset=utf-8` });
  res.end(body);
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startTesterServer().ready.then(() => console.log(hostingReady(process.env) ? 'Tester server started; HTTPS ingress must be provided by the host.' : 'Tester workspace not hosted; access is closed.'));
}
