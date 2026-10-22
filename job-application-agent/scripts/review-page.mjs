// One-shot local approval page for a review batch. Listens on 127.0.0.1 only, behind a
// random path secret, serves static HTML with no scripts and no external requests, and
// exits after the candidate decides or after the timeout.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFile, rename, chmod, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isEntrypoint } from './entrypoint.mjs';
import { approvalPhrase, approveBatch, closeBatch, effectiveStatus, loadBatch } from './review-batch.mjs';

export const REVIEW_PAGE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_BODY = 64 * 1024;

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function displayUrl(url) {
  try { const u = new URL(url); return `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { return url; }
}
function safeHref(url) {
  try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.href : null; } catch { return null; }
}
function formatTime(iso) {
  const date = new Date(iso);
  return date.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

const STYLE = `
:root{--ink:#173f35;--text:#486159;--muted:#5d746c;--bg:#f2e9d8;--surface:#fffaf0;--line:#d8ccb7;--accent:#2f755f;--accent-strong:#245e4c;--accent-soft:#dfeee6;--coral:#9f4d42;--coral-soft:#f4e2dc;--amber-soft:#f6ead0;--amber:#7a5a12}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.wrap{max-width:880px;margin:0 auto;padding:32px 24px 180px}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);font-weight:600;font-size:15px;letter-spacing:.01em}
.mark{width:28px;height:28px;border-radius:8px;background:var(--ink);color:var(--surface);display:grid;place-items:center;font:700 13px/1 Georgia,serif}
h1{font:400 32px/1.2 Georgia,"Times New Roman",serif;color:var(--ink);margin:28px 0 8px}
.lede{margin:0 0 20px;max-width:62ch}
.meta{display:flex;flex-wrap:wrap;gap:8px 16px;font-size:14px;color:var(--muted);margin-bottom:24px}
.meta b{color:var(--ink);font-weight:600}
.notice{background:var(--surface);border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:10px;padding:12px 16px;font-size:14px;margin-bottom:24px}
.list{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px 18px;display:grid;grid-template-columns:auto 1fr;gap:4px 14px}
.card:has(input:not(:checked)){opacity:.62;border-style:dashed}
.check{grid-row:span 3;padding-top:3px}
.check input{width:22px;height:22px;accent-color:var(--accent);margin:0;cursor:pointer}
.title{cursor:pointer;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;color:var(--ink)}
.num{font:600 13px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;color:var(--muted)}
.company{font-weight:600;font-size:17px}
.role{font-size:17px}
.sub{display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;font-size:14px}
.sub a{color:var(--accent);word-break:break-all}
.pill{display:inline-block;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600;background:var(--accent-soft);color:var(--accent-strong)}
.pill.kind{background:#ece4d3;color:var(--ink)}
.pill.flag{background:var(--amber-soft);color:var(--amber)}
details{grid-column:2;margin-top:6px;border-top:1px solid var(--line);padding-top:8px}
summary{cursor:pointer;font-size:14px;font-weight:600;color:var(--ink)}
dl{margin:10px 0 0;display:grid;gap:10px}
dt{font-size:13px;font-weight:600;color:var(--ink)}
dt .pill{margin-left:6px}
dd{margin:2px 0 0;white-space:pre-wrap;font-size:14px;background:#fbf4e6;border-radius:8px;padding:8px 10px}
dd.flagged{background:var(--amber-soft)}
.email{white-space:pre-wrap;font-size:14px;background:#fbf4e6;border-radius:8px;padding:10px 12px;margin:10px 0 0}
.bar{position:fixed;left:0;right:0;bottom:0;background:rgba(255,250,240,.97);border-top:1px solid var(--line);box-shadow:0 -6px 24px rgba(23,63,53,.08)}
.bar-in{max-width:880px;margin:0 auto;padding:14px 24px 18px;display:grid;grid-template-columns:1fr auto;gap:10px 16px;align-items:end}
label.code{display:grid;gap:6px;font-size:14px;color:var(--ink);font-weight:600}
label.code span b{font:600 15px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;background:var(--accent-soft);padding:2px 6px;border-radius:6px;letter-spacing:.04em}
input[type=text]{font:600 17px/1 ui-monospace,"SF Mono",Menlo,Consolas,monospace;letter-spacing:.06em;text-transform:uppercase;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:var(--ink);width:100%;max-width:360px}
input[type=text]:focus,button:focus-visible,summary:focus-visible,.check input:focus-visible{outline:3px solid #8fcfb3;outline-offset:2px}
.actions{display:flex;gap:10px;align-items:center}
button{font:600 15px/1 inherit;font-family:inherit;border-radius:10px;padding:13px 18px;cursor:pointer;border:1px solid transparent}
.primary{background:var(--ink);color:var(--surface)}
.primary:hover{background:var(--accent-strong)}
.ghost{background:transparent;color:var(--coral);border-color:#e3c3bb}
.ghost:hover{background:var(--coral-soft)}
.err{grid-column:1/-1;color:var(--coral);font-size:14px;font-weight:600;margin:0}
.done{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:28px;margin-top:28px}
.done h1{margin-top:0}
@media (max-width:640px){
 .wrap{padding:20px 16px 200px}
 h1{font-size:26px;margin-top:20px}
 .card{padding:14px;gap:4px 12px}
 .company,.role{font-size:16px}
 .bar-in{grid-template-columns:1fr;padding:12px 16px 16px}
 input[type=text]{max-width:none}
 .actions button{flex:1}
 label.code{font-size:13px}
}`;

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><div class="wrap"><div class="brand"><span class="mark">J</span>JobAppAgent · Batch review</div>${body}</div></body></html>`;
}

function answersBlock(item) {
  const entries = Object.entries(item.answers);
  if (!entries.length) return '<details><summary>No drafted answers. Profile fields and résumé only</summary></details>';
  const flagged = new Set(item.flaggedAnswers);
  const rows = entries.map(([key, value]) => `<dt>${escapeHtml(key)}${flagged.has(key) ? '<span class="pill flag">Check this</span>' : ''}</dt><dd${flagged.has(key) ? ' class="flagged"' : ''}>${escapeHtml(value)}</dd>`).join('');
  return `<details${flagged.size ? ' open' : ''}><summary>${entries.length} drafted answer${entries.length === 1 ? '' : 's'} to be sent${flagged.size ? ` · ${flagged.size} flagged` : ''}</summary><dl>${rows}</dl></details>`;
}

function itemCard(item, checked) {
  const id = `c-${escapeHtml(item.itemId)}`;
  const box = `<span class="check"><input type="checkbox" id="${id}" name="item" value="${escapeHtml(item.itemId)}"${checked ? ' checked' : ''}></span>`;
  if (item.type === 'email') {
    return `<li class="card">${box}<label class="title" for="${id}"><span class="num">${item.number}</span><span class="company">${escapeHtml(item.company)}</span><span class="role">Recruiting email</span></label><div class="sub"><span class="pill kind">Email</span>${item.recipient ? `<span>To ${escapeHtml(item.recipient)}</span>` : ''}<span>Draft revision ${item.draftRevision}</span></div><details open><summary>Exact text you will send</summary><p class="email">${escapeHtml(item.text)}</p></details></li>`;
  }
  const href = safeHref(item.url);
  const link = href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(displayUrl(item.url))}</a>` : escapeHtml(item.url);
  return `<li class="card">${box}<label class="title" for="${id}"><span class="num">${item.number}</span><span class="company">${escapeHtml(item.company)}</span><span class="role">${escapeHtml(item.role)}</span></label><div class="sub"><span class="pill">Fit ${item.fitScore}</span>${item.purpose === 'retry' ? '<span class="pill flag">Resend</span>' : ''}${item.ats ? `<span class="pill kind">${escapeHtml(item.ats)}</span>` : ''}${link}</div>${answersBlock(item)}</li>`;
}

function resumeLine(batch) {
  if (!batch.resume?.sha256) return 'No résumé on file';
  const kb = Number.isInteger(batch.resume.bytes) ? ` · ${Math.max(1, Math.round(batch.resume.bytes / 1024))} KB` : '';
  return `Your canonical résumé${kb} · <span title="sha256 ${escapeHtml(batch.resume.sha256)}">${escapeHtml(batch.resume.sha256.slice(0, 8))}</span>`;
}

export function renderReviewPage(batch, { action, error = null, selected = null, now = new Date() } = {}) {
  const status = effectiveStatus(batch, now);
  if (status !== 'pending') return renderDecided(batch, now);
  const chosen = selected ? new Set(selected) : new Set(batch.items.map((item) => item.itemId));
  const apps = batch.items.filter((item) => item.type === 'application').length;
  const emails = batch.items.length - apps;
  const counts = [apps ? `${apps} application${apps === 1 ? '' : 's'}` : null, emails ? `${emails} email${emails === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
  const body = `
<h1>Review ${counts} before anything is sent</h1>
<p class="lede">Your agent filled these but has not sent them. Read each one, untick anything you don't want sent, then type the code to approve. Approval covers exactly what you see here, once.</p>
<div class="meta"><span>Résumé: <b>${resumeLine(batch)}</b></span><span>Decide by <b>${escapeHtml(formatTime(batch.pendingExpiresAt))}</b></span><span>Batch <b>${escapeHtml(batch.code)}</b></span></div>
<div class="notice">Only you should use this page; your agent must not open or operate it. If an answer or the résumé changes after you approve, the agent has to ask you again. Approval lasts 24 hours.</div>
<form method="post" action="${escapeHtml(action)}" autocomplete="off">
<ol class="list">${batch.items.map((item) => itemCard(item, chosen.has(item.itemId))).join('')}</ol>
<div class="bar"><div class="bar-in">
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
<label class="code"><span>Type <b>${escapeHtml(batch.code)}</b> to approve the ticked items</span><input type="text" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="12" placeholder="${escapeHtml(batch.code)}" required></label>
<div class="actions"><button class="ghost" type="submit" name="decision" value="reject" formnovalidate>Reject all</button><button class="primary" type="submit" name="decision" value="approve">Approve ticked</button></div>
</div></div>
</form>`;
  return shell(`Review batch ${batch.code} · JobAppAgent`, body);
}

function renderDecided(batch, now) {
  const status = effectiveStatus(batch, now);
  if (status === 'approved') {
    const n = batch.approvedItemIds.length;
    const removed = batch.items.length - n;
    return shell('Approved · JobAppAgent', `<div class="done"><h1>Approved ${n} of ${batch.items.length}</h1><p class="lede">Your agent can now send ${n === 1 ? 'this item' : 'these items'}, each once, until ${escapeHtml(formatTime(batch.expiresAt))}.${removed ? ` ${removed} unticked item${removed === 1 ? '' : 's'} will not be sent.` : ''} You can close this tab and go back to your agent.</p></div>`);
  }
  if (status === 'rejected') return shell('Rejected · JobAppAgent', '<div class="done"><h1>Batch rejected</h1><p class="lede">Nothing in this batch will be sent. You can close this tab and tell your agent what to change.</p></div>');
  if (status === 'revoked') return shell('Revoked · JobAppAgent', '<div class="done"><h1>Batch revoked</h1><p class="lede">This batch was withdrawn. Nothing more from it will be sent.</p></div>');
  return shell('Expired · JobAppAgent', '<div class="done"><h1>This batch expired</h1><p class="lede">Nothing was approved. Ask your agent to prepare a fresh batch.</p></div>');
}

function readForm(request) {
  return new Promise((resolveBody, reject) => {
    let size = 0; const chunks = [];
    request.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY) { reject(new Error('too large')); request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => resolveBody(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))));
    request.on('error', reject);
  });
}

const sameSecret = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** Start the page. Resolves with { url, close, done } once listening. */
export async function startReviewPage({ stateDir, batchId, timeoutMs = REVIEW_PAGE_TIMEOUT_MS, port = 0 }) {
  await loadBatch(stateDir, batchId);
  const secret = randomBytes(24).toString('base64url');
  const path = `/review/${secret}`;
  let origin = '';
  let finish;
  const done = new Promise((resolveDone) => { finish = resolveDone; });
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  };
  const send = (response, status, html) => { response.writeHead(status, headers); response.end(html); };
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? '';
      if (host !== origin.slice('http://'.length)) return send(response, 421, 'Wrong host');
      const url = new URL(request.url, origin);
      if (!sameSecret(url.pathname, path)) return send(response, 404, 'Not found');
      if (request.method === 'GET') return send(response, 200, renderReviewPage(await loadBatch(stateDir, batchId), { action: path }));
      if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
      const requestOrigin = request.headers.origin;
      if (requestOrigin != null && requestOrigin !== origin) return send(response, 403, 'Cross-origin request refused');
      if (!/^application\/x-www-form-urlencoded/.test(request.headers['content-type'] ?? '')) return send(response, 415, 'Unsupported form');
      const form = await readForm(request);
      const batch = await loadBatch(stateDir, batchId);
      if (effectiveStatus(batch) !== 'pending') return send(response, 200, renderReviewPage(batch, { action: path }));
      if (form.get('decision') === 'reject') {
        const closed = await closeBatch(stateDir, batchId, 'rejected');
        send(response, 200, renderReviewPage(closed, { action: path }));
        return finish('rejected');
      }
      const selected = form.getAll('item');
      if (!selected.length) return send(response, 422, renderReviewPage(batch, { action: path, selected, error: 'Nothing is ticked. Tick at least one item, or choose Reject all.' }));
      const code = String(form.get('code') ?? '');
      if (`APPROVE ${code.trim().toUpperCase()}` !== approvalPhrase(batch)) {
        return send(response, 422, renderReviewPage(batch, { action: path, selected, error: `That code doesn't match. Type ${batch.code} exactly.` }));
      }
      const { batch: approved } = await approveBatch(stateDir, batchId, { channel: 'local-page', phrase: approvalPhrase(batch), itemIds: selected });
      send(response, 200, renderReviewPage(approved, { action: path }));
      return finish('approved');
    } catch (error) {
      if (!response.headersSent) send(response, 400, shell('Error · JobAppAgent', `<div class="done"><h1>Something went wrong</h1><p class="lede">${escapeHtml(error.message)}</p></div>`));
    }
  });
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveListen); });
  origin = `http://127.0.0.1:${server.address().port}`;
  const timer = setTimeout(() => finish('timeout'), timeoutMs);
  timer.unref?.();
  const close = () => new Promise((resolveClose) => { clearTimeout(timer); server.close(() => resolveClose()); server.closeAllConnections?.(); });
  return { url: `${origin}${path}`, done, close };
}

// Detached child entrypoint: `node review-page.mjs <stateDir> <batchId> <infoFile>`.
if (isEntrypoint(import.meta.url)) {
  const [stateDir, batchId, infoFile] = process.argv.slice(2);
  const page = await startReviewPage({ stateDir, batchId });
  const temporary = `${infoFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ url: page.url, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
  await rename(temporary, infoFile);
  await chmod(infoFile, 0o600);
  await page.done;
  // Let the final response flush before exiting.
  setTimeout(async () => { await page.close(); await unlink(infoFile).catch(() => {}); process.exit(0); }, 1500);
}

export const reviewPageInfoFile = (stateDir, batchId) => join(stateDir, 'review-batches', `${batchId}.page.json`);
