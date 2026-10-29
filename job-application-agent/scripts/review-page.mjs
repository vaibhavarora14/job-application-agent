// One-shot local approval page for a review batch. Listens on 127.0.0.1 only, behind a
// random path secret, serves HTML whose only script is one fixed, nonce-bound inline snippet
// (the live approve count), makes no external requests, and exits after the candidate
// decides or after the timeout.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, rename, chmod, unlink } from 'node:fs/promises';
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
/** Zone label such as IST, CEST or PDT. Falls back to the initials of the long name when the short one is a GMT offset. */
export function zoneLabel(date, timeZone) {
  const part = (style) => new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: style }).formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? '';
  const short = part('short');
  if (short && !/^(GMT|UTC)[+-]/.test(short)) return short;
  const long = part('long');
  if (/^Coordinated Universal Time$/i.test(long)) return 'UTC';
  const initials = long.split(/\s+/).filter((w) => /^[A-Z]/.test(w)).map((w) => w[0]).join('');
  return initials.length >= 2 ? initials : short || 'UTC';
}

/** "Fri 23 Oct, 2:03 PM IST" in the machine's local zone (or `timeZone`). */
export function formatTime(iso, timeZone = undefined) {
  const date = new Date(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(date).map((p) => [p.type, p.value]));
  const clock = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(date);
  return `${parts.weekday} ${parts.day} ${parts.month}, ${clock} ${zoneLabel(date, timeZone)}`;
}

const STYLE = `
:root{--ink:#173f35;--text:#486159;--muted:#5d746c;--bg:#f2e9d8;--surface:#fffaf0;--line:#d8ccb7;--accent:#2f755f;--accent-strong:#245e4c;--accent-soft:#dfeee6;--coral:#9f4d42;--coral-soft:#f4e2dc;--amber-soft:#f6ead0;--amber:#7a5a12}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-padding-bottom:220px}
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
.bar{position:fixed;z-index:10;left:0;right:0;bottom:0;background:var(--surface);border-top:1px solid var(--line);box-shadow:0 -6px 24px rgba(23,63,53,.08)}
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
.rlink{color:var(--accent);font-weight:600}
.dim{color:var(--muted)}
dd.why{margin:0;padding:0 2px;background:none;font-size:13px;color:var(--amber);white-space:normal}
.hdrs{grid-column:2;display:grid;gap:4px;margin-top:8px;font-size:14px}
.hdrs div{display:grid;grid-template-columns:72px 1fr;gap:8px}
.hdrs span{color:var(--muted)}
.hdrs b{color:var(--ink);font-weight:600;word-break:break-word}
.primary:disabled{background:#9aa9a3;cursor:not-allowed}
.res{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:8px;font-size:15px}
.res li{padding:10px 12px;border-radius:10px;background:#fbf4e6;color:var(--ink)}
.res .ok{border-left:4px solid var(--accent)}
.res .no{border-left:4px solid var(--line);color:var(--muted)}
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

// The only script: keeps the primary button's count in step with the ticked boxes. Fixed text,
// never interpolated, and allowed by a per-response CSP nonce.
export const COUNT_SCRIPT = 'const b=document.getElementById("go");function u(){const n=document.querySelectorAll(".check input:checked").length;b.textContent=n?"Approve "+n+" item"+(n>1?"s":""):"Nothing ticked";b.disabled=!n}document.querySelectorAll(".check input").forEach(function(i){i.addEventListener("change",u)});';

function shell(title, body, { nonce = null } = {}) {
  const script = nonce ? `<script nonce="${escapeHtml(nonce)}">${COUNT_SCRIPT}</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="same-origin"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><div class="wrap"><div class="brand"><span class="mark">J</span>JobAppAgent · Batch review</div>${body}</div>${script}</body></html>`;
}
const approveLabel = (n) => (n ? `Approve ${n} item${n === 1 ? '' : 's'}` : 'Nothing ticked');

function answersBlock(item) {
  const entries = Object.entries(item.answers);
  if (!entries.length) return '<details><summary>No drafted answers. Profile fields and résumé only</summary></details>';
  const flagged = new Map(item.flaggedAnswers.map((flag) => [flag.answer, flag.reason]));
  const rows = entries.map(([key, value]) => (flagged.has(key)
    ? `<dt>${escapeHtml(key)}<span class="pill flag">Check this</span></dt><dd class="flagged">${escapeHtml(value)}</dd><dd class="why">Flagged because ${escapeHtml(lowerFirst(flagged.get(key)))} Untick if you want to answer it yourself.</dd>`
    : `<dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd>`)).join('');
  return `<details open><summary>${entries.length} drafted answer${entries.length === 1 ? '' : 's'} to be sent${flagged.size ? ` · ${flagged.size} flagged` : ''}</summary><dl>${rows}</dl></details>`;
}

function lowerFirst(reason) {
  const text = String(reason).trim().replace(/^because\s+/i, '');
  const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
  return /^[A-Z][a-z]/.test(sentence) ? sentence[0].toLowerCase() + sentence.slice(1) : sentence;
}

function itemCard(item, checked) {
  const id = `c-${escapeHtml(item.itemId)}`;
  const box = `<span class="check"><input type="checkbox" id="${id}" name="item" value="${escapeHtml(item.itemId)}"${checked ? ' checked' : ''}></span>`;
  if (item.type === 'email') {
    const to = item.recipient ? `${item.recipient} · ${item.to}` : item.to;
    const hdrs = `<div class="hdrs"><div><span>To</span><b>${escapeHtml(to)}</b></div><div><span>Subject</span><b>${item.subject ? escapeHtml(item.subject) : '<span class="dim">No subject</span>'}</b></div><div><span>Attached</span><b>${item.attachResume ? 'Your résumé (same PDF as above)' : '<span class="dim">Nothing</span>'}</b></div></div>`;
    return `<li class="card" id="item-${escapeHtml(item.itemId)}">${box}<label class="title" for="${id}"><span class="num">${item.number}</span><span class="company">${escapeHtml(item.company)}</span><span class="role">Recruiting email</span></label><div class="sub"><span class="pill kind">Email</span></div>${hdrs}<details open><summary>Exact text that will be sent</summary><p class="email">${escapeHtml(item.text)}</p></details></li>`;
  }
  const href = safeHref(item.url);
  const link = href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener">${escapeHtml(displayUrl(item.url))}</a>` : escapeHtml(item.url);
  return `<li class="card" id="item-${escapeHtml(item.itemId)}">${box}<label class="title" for="${id}"><span class="num">${item.number}</span><span class="company">${escapeHtml(item.company)}</span><span class="role">${escapeHtml(item.role)}</span></label><div class="sub"><span class="pill">Fit ${item.fitScore}</span>${item.purpose === 'retry' ? '<span class="pill flag">Resend</span>' : ''}${item.ats ? `<span class="pill kind">${escapeHtml(item.ats)}</span>` : ''}${link}</div>${answersBlock(item)}</li>`;
}

function resumeLine(batch, action) {
  if (!batch.resume?.sha256) return '<b>No résumé on file</b>';
  const kb = Number.isInteger(batch.resume.bytes) ? ` <span class="dim">(${Math.max(1, Math.round(batch.resume.bytes / 1024))} KB)</span>` : '';
  return `<a class="rlink" href="${escapeHtml(action)}/resume.pdf" target="_blank" rel="noreferrer noopener" title="sha256 ${escapeHtml(batch.resume.sha256)}">Open the exact PDF that will be sent</a>${kb}`;
}

export function renderReviewPage(batch, { action, error = null, selected = null, now = new Date(), nonce = null, timeZone = undefined } = {}) {
  const status = effectiveStatus(batch, now);
  if (status !== 'pending') return renderDecided(batch, now, timeZone);
  const chosen = selected ? new Set(selected) : new Set(batch.items.map((item) => item.itemId));
  const apps = batch.items.filter((item) => item.type === 'application').length;
  const emails = batch.items.length - apps;
  const counts = [apps ? `${apps} application${apps === 1 ? '' : 's'}` : null, emails ? `${emails} email${emails === 1 ? '' : 's'}` : null].filter(Boolean).join(' and ');
  const body = `
<h1>Review ${counts} before anything is sent</h1>
<p class="lede">Your agent filled these but has not sent them. Read each one, untick anything you don't want sent, then type the code to approve. Approval covers exactly what you see here, once.</p>
<div class="meta"><span>Résumé: ${resumeLine(batch, action)}</span><span>Decide by <b>${escapeHtml(formatTime(batch.pendingExpiresAt, timeZone))}</b></span><span>Batch <b>${escapeHtml(batch.code)}</b></span></div>
<div class="notice">Only you can approve this. Your agent can’t open this page. If any answer or the résumé changes after you approve, it has to ask you again.</div>
<form method="post" action="${escapeHtml(action)}" autocomplete="off">
<ol class="list">${batch.items.map((item) => itemCard(item, chosen.has(item.itemId))).join('')}</ol>
<div class="bar"><div class="bar-in">
${error ? `<p class="err" id="review-error" role="alert">${escapeHtml(error)}</p>` : ''}
<label class="code"><span>Type <b>${escapeHtml(batch.code)}</b> to approve the ticked items</span><input type="text" name="code" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="12" required${error ? ' autofocus aria-invalid="true" aria-describedby="review-error"' : ''}></label>
<div class="actions"><button class="ghost" type="submit" name="decision" value="reject" formnovalidate>Reject all</button><button class="primary" type="submit" name="decision" value="approve" id="go"${chosen.size ? '' : ' disabled'}>${approveLabel(chosen.size)}</button></div>
</div></div>
</form>`;
  return shell(`Review batch ${batch.code} · JobAppAgent`, body, { nonce });
}

function itemLabel(item) {
  return item.type === 'email' ? `Email to ${item.recipient ?? item.to} at ${item.company}` : `${item.company}, ${item.role}`;
}

function renderDecided(batch, now, timeZone) {
  const status = effectiveStatus(batch, now);
  if (status === 'approved') {
    const approved = new Set(batch.approvedItemIds);
    const n = approved.size;
    const rows = [
      ...batch.items.filter((item) => approved.has(item.itemId)).map((item) => `<li class="ok">Will send · ${escapeHtml(itemLabel(item))}</li>`),
      ...batch.items.filter((item) => !approved.has(item.itemId)).map((item) => `<li class="no">Won’t send · ${escapeHtml(itemLabel(item))} (unticked)</li>`),
    ].join('');
    return shell('Approved · JobAppAgent', `<div class="done"><h1>Approved ${n} of ${batch.items.length}</h1><p class="lede">Your agent can send each of these once, until ${escapeHtml(formatTime(batch.expiresAt, timeZone))}. You can close this tab.</p><ul class="res">${rows}</ul></div>`);
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
  const baseHeaders = {
    'cache-control': 'no-store',
    'x-frame-options': 'DENY',
    // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on the form
    // POST, which the origin check below must refuse. Outbound job links carry rel=noreferrer.
    'referrer-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
  };
  // Each response gets its own CSP nonce, recorded on the response object.
  const send = (response, status, html) => {
    const nonce = response.cspNonce ?? randomBytes(16).toString('base64');
    response.writeHead(status, {
      ...baseHeaders,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    });
    response.end(html);
  };
  const pageFor = (response) => (batch, extra = {}) => {
    response.cspNonce = randomBytes(16).toString('base64');
    return renderReviewPage(batch, { action: path, nonce: response.cspNonce, ...extra });
  };
  // Serves the canonical résumé only while it is byte-identical to the one this batch was staged with.
  const sendResume = async (response) => {
    const batch = await loadBatch(stateDir, batchId);
    let bytes = null;
    try { bytes = await readFile(join(stateDir, 'resume.pdf')); } catch { bytes = null; }
    if (!bytes || !batch.resume?.sha256 || createHash('sha256').update(bytes).digest('hex') !== batch.resume.sha256) {
      return send(response, 409, shell('Résumé changed · JobAppAgent', '<div class="done"><h1>The résumé changed</h1><p class="lede">The PDF on file is not the one this batch was prepared with. Don’t approve; ask your agent to prepare the batch again.</p></div>'));
    }
    response.writeHead(200, { ...baseHeaders, 'content-type': 'application/pdf', 'content-disposition': 'inline; filename="resume.pdf"', 'content-length': bytes.length, 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
    return response.end(bytes);
  };
  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? '';
      if (host !== origin.slice('http://'.length)) return send(response, 421, 'Wrong host');
      const url = new URL(request.url, origin);
      const page = pageFor(response);
      if (request.method === 'GET' && sameSecret(url.pathname, `${path}/resume.pdf`)) return sendResume(response);
      if (!sameSecret(url.pathname, path)) return send(response, 404, 'Not found');
      if (request.method === 'GET') return send(response, 200, page(await loadBatch(stateDir, batchId)));
      if (request.method !== 'POST') return send(response, 405, 'Method not allowed');
      const requestOrigin = request.headers.origin;
      if (requestOrigin != null && requestOrigin !== origin) return send(response, 403, 'Cross-origin request refused');
      const fetchSite = request.headers['sec-fetch-site'];
      if (fetchSite != null && !['same-origin', 'none'].includes(fetchSite)) return send(response, 403, 'Cross-site request refused');
      if (!/^application\/x-www-form-urlencoded/.test(request.headers['content-type'] ?? '')) return send(response, 415, 'Unsupported form');
      const form = await readForm(request);
      const batch = await loadBatch(stateDir, batchId);
      if (effectiveStatus(batch) !== 'pending') return send(response, 200, page(batch));
      if (form.get('decision') === 'reject') {
        const closed = await closeBatch(stateDir, batchId, 'rejected');
        send(response, 200, page(closed));
        return finish('rejected');
      }
      const selected = form.getAll('item');
      if (!selected.length) return send(response, 422, page(batch, { selected, error: 'Nothing is ticked. Tick at least one item, or choose Reject all.' }));
      const code = String(form.get('code') ?? '');
      if (`APPROVE ${code.trim().toUpperCase()}` !== approvalPhrase(batch)) {
        return send(response, 422, page(batch, { selected, error: `That code doesn't match. Type ${batch.code} exactly.` }));
      }
      const { batch: approved } = await approveBatch(stateDir, batchId, { channel: 'local-page', phrase: approvalPhrase(batch), itemIds: selected });
      send(response, 200, page(approved));
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
