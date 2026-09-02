import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveAttention } from './attention.mjs';
import { saveAnswer } from './answers.mjs';
import { markSubmitted } from './apply/applications.mjs';
import { enqueue } from './queue.mjs';
import { startRound } from './round.mjs';
import { extrasFromBody, getProfile, saveProfile, storeResume } from './skill.mjs';
import { cloudStatus } from './status.mjs';
import { openDb } from './db.mjs';
import { ensureDataDirs, skillStateDir } from './paths.mjs';

const UI_PATH = fileURLToPath(new URL('./ui.html', import.meta.url));

export function startServer(env = process.env, { embedWorker = env.CLOUD_EMBED_WORKER !== '0' } = {}) {
  ensureDataDirs(env);
  const host = env.HOST || '127.0.0.1';
  const port = Number(env.PORT || 8787);
  const server = createServer((req, res) => {
    handle(req, res, env).catch((error) => {
      json(res, 500, { error: error.message });
    });
  });
  const ready = new Promise((resolve) => {
    server.listen(port, host, () => resolve({ host, port: server.address().port }));
  });
  let stopWorker = () => {};
  if (embedWorker) {
    import('./worker.mjs').then((mod) => mod.startWorker(env)).then((stop) => { stopWorker = stop; });
  }
  return {
    ready,
    close: () => new Promise((resolve) => {
      stopWorker();
      server.close(() => resolve());
    }),
  };
}

async function handle(req, res, env) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  if (req.method === 'GET' && url.pathname === '/') {
    const html = await readFile(UI_PATH, 'utf8');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(res, 200, await cloudStatus(env));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/onboard') {
    const body = await readJson(req);
    const saved = saveProfile(body.profile, extrasFromBody(body.extras || body), null, env);
    json(res, 200, { ok: true, configured: saved.configured, missing: saved.missing });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/resume') {
    const dest = join(skillStateDir(env), `upload-${Date.now()}.pdf`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    await writeFile(dest, Buffer.concat(chunks));
    const path = await storeResume(dest, env);
    json(res, 200, { ok: true, resumePath: Boolean(path) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/rounds') {
    const body = await readJson(req);
    json(res, 202, startRound(body.count, env));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/discover') {
    const job = enqueue('discover', { source: 'api' }, env);
    json(res, 202, job);
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/attention/') && url.pathname.endsWith('/resolve')) {
    const id = url.pathname.split('/')[3];
    const body = await readJson(req);
    json(res, 200, resolveAttention(id, { note: body.note, resumeFill: Boolean(body.resumeFill), env }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/answers') {
    const body = await readJson(req);
    json(res, 200, saveAnswer({ ...body, env }));
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/applications/') && url.pathname.endsWith('/confirm')) {
    const id = url.pathname.split('/')[3];
    const body = await readJson(req);
    const row = openDb(env).prepare('SELECT a.*, j.application_channel, j.employer_job_id, j.discovery_source FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?').get(id);
    if (!row) {
      json(res, 404, { error: 'application not found' });
      return;
    }
    const result = await markSubmitted({
      applicationId: id,
      job: row,
      score: 0,
      approval: 'APPROVE SUBMIT',
      confirmationUrl: body.confirmationUrl || row.url,
      confirmationExcerpt: body.confirmationExcerpt || 'operator-confirmed',
      env,
    });
    json(res, result.ok ? 200 : 409, result);
    return;
  }
  json(res, 404, { error: 'not found' });
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer(process.env).ready.then(({ host, port }) => {
    console.log(`cloud operator on http://${host}:${port} (use fly proxy; do not publish)`);
  });
}
