// Batch review: the only path to a live submission, a replacement transmission, or an
// outreach handoff. The agent stages what it intends to send, a human approves it on the
// local review page (or by typing the confirmation phrase in chat), and the CLI then
// refuses to prepare or record any send that is not covered by an unexpired, unused,
// unchanged approval.
//
// Honest limit: the CLI cannot stop a click made directly in the browser. It gates the
// sanctioned steps around that click: `cloud intent-prepare`, `ledger add`, `ledger retry`,
// and `outreach handoff`.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalUrl, stableJson } from './application-accounting.mjs';

export const REVIEW_BATCH_MAX_ITEMS = 25;
export const REVIEW_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const REVIEW_PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export const REVIEW_CHANNELS = Object.freeze(['local-page', 'chat-phrase']);
const TOKEN_PREFIX = 'rbt1';
const BATCH_ID = /^rb-\d{8}-[0-9a-f]{8}$/;
const CODE_LETTERS = 'ACDEFHJKMNPRTVWXY';
const PURPOSES = new Set(['submit', 'retry']);
const MAX_ANSWERS = 200;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const answersDigest = (answers) => sha256(stableJson(answers ?? {}));

function fail(message) { throw new Error(message); }
function text(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label} must be a non-empty string no longer than ${max} characters.`);
  return value.trim();
}
function optionalText(value, label, max) { return value == null ? null : text(value, label, max); }
function keysOnly(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`Unknown ${label} property: ${key}.`);
  return value;
}

function normalizeAnswers(raw, label) {
  const answers = raw ?? {};
  keysOnly(answers, Object.keys(answers), label);
  const entries = Object.entries(answers);
  if (entries.length > MAX_ANSWERS) fail(`${label} may contain at most ${MAX_ANSWERS} answers.`);
  for (const [key, value] of entries) { text(key, 'answer key', 200); text(value, `answer ${key}`, 5000); }
  return answers;
}

function normalizeItem(raw, index) {
  const label = `items[${index}]`;
  if (raw?.type === 'email') {
    keysOnly(raw, ['type', 'opportunityId', 'draftRevision', 'company', 'recipient', 'to', 'subject', 'attachResume', 'text'], label);
    if (!Number.isInteger(raw.draftRevision) || raw.draftRevision < 1) fail(`${label}.draftRevision must be a positive integer.`);
    if (raw.attachResume != null && typeof raw.attachResume !== 'boolean') fail(`${label}.attachResume must be a Boolean.`);
    const body = text(raw.text, `${label}.text`, 4000);
    const headers = {
      to: text(raw.to, `${label}.to (the recipient address or profile from the draft)`, 320),
      subject: optionalText(raw.subject, `${label}.subject`, 300),
      attachResume: raw.attachResume === true,
    };
    return {
      type: 'email',
      opportunityId: text(raw.opportunityId, `${label}.opportunityId`, 180),
      draftRevision: raw.draftRevision,
      company: text(raw.company, `${label}.company`, 300),
      recipient: optionalText(raw.recipient, `${label}.recipient`, 300),
      ...headers,
      text: body,
      // Headers are part of what the candidate approves, so they are bound with the text.
      textSha256: sha256(stableJson({ text: body, ...headers })),
    };
  }
  if (raw?.type !== 'application') fail(`${label}.type must be "application" or "email".`);
  keysOnly(raw, ['type', 'purpose', 'applicationId', 'company', 'role', 'url', 'ats', 'fitScore', 'answers', 'flaggedAnswers'], label);
  const purpose = raw.purpose ?? 'submit';
  if (!PURPOSES.has(purpose)) fail(`${label}.purpose must be "submit" or "retry".`);
  if (!Number.isInteger(raw.fitScore) || raw.fitScore < 0 || raw.fitScore > 100) fail(`${label}.fitScore must be an integer from 0 to 100.`);
  const answers = normalizeAnswers(raw.answers, `${label}.answers`);
  const flagged = raw.flaggedAnswers ?? [];
  if (!Array.isArray(flagged)) fail(`${label}.flaggedAnswers must be an array.`);
  const flags = flagged.map((flag, i) => {
    if (!flag || typeof flag !== 'object' || Array.isArray(flag)) fail(`${label}.flaggedAnswers[${i}] must be { "answer": "<answer key>", "reason": "<why to check it>" }.`);
    keysOnly(flag, ['answer', 'reason'], `${label}.flaggedAnswers[${i}]`);
    if (!Object.hasOwn(answers, flag.answer)) fail(`${label}.flaggedAnswers[${i}].answer must name a key in answers.`);
    return { answer: flag.answer, reason: text(flag.reason, `${label}.flaggedAnswers[${i}].reason (why the candidate should check it)`, 400) };
  });
  if (new Set(flags.map((f) => f.answer)).size !== flags.length) fail(`${label}.flaggedAnswers lists an answer twice.`);
  let url;
  try { url = canonicalUrl(raw.url); } catch { fail(`${label}.url must be a public HTTP(S) URL.`); }
  return {
    type: 'application',
    purpose,
    applicationId: text(raw.applicationId, `${label}.applicationId`, 180),
    company: text(raw.company, `${label}.company`, 300),
    role: text(raw.role, `${label}.role`, 300),
    url,
    ats: optionalText(raw.ats, `${label}.ats`, 40)?.toLowerCase() ?? null,
    fitScore: raw.fitScore,
    answers,
    answersSha256: answersDigest(answers),
    flaggedAnswers: flags,
  };
}

const itemKey = (item) => (item.type === 'email' ? `email:${item.opportunityId}:${item.draftRevision}` : `${item.purpose}:${item.applicationId}`);

export function validateStageInput(input) {
  keysOnly(input, ['items', 'roundId'], 'review stage');
  if (!Array.isArray(input.items) || input.items.length === 0) fail('review stage needs at least one item.');
  if (input.items.length > REVIEW_BATCH_MAX_ITEMS) fail(`A review batch holds at most ${REVIEW_BATCH_MAX_ITEMS} items. Split the work into several batches.`);
  const items = input.items.map(normalizeItem);
  const seen = new Set();
  for (const item of items) {
    const key = itemKey(item);
    if (seen.has(key)) fail(`The batch lists the same ${item.type === 'email' ? 'email draft' : 'application'} twice.`);
    seen.add(key);
  }
  return { items, roundId: optionalText(input.roundId, 'roundId', 180) };
}

function batchesDir(stateDir) { return join(stateDir, 'review-batches'); }
function batchFile(stateDir, batchId) {
  if (typeof batchId !== 'string' || !BATCH_ID.test(batchId)) fail('Unknown review batch ID.');
  return join(batchesDir(stateDir), `${batchId}.json`);
}

async function writePrivate(file, value) {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function ensureDir(stateDir) {
  await mkdir(batchesDir(stateDir), { recursive: true, mode: 0o700 });
  await chmod(batchesDir(stateDir), 0o700);
}

async function reviewSecret(stateDir) {
  const file = join(stateDir, 'review-secret.key');
  try { return Buffer.from((await readFile(file, 'utf8')).trim(), 'hex'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const secret = randomBytes(32);
  try {
    const handle = await open(file, 'wx', 0o600);
    try { await handle.writeFile(secret.toString('hex')); } finally { await handle.close(); }
    return secret;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return Buffer.from((await readFile(file, 'utf8')).trim(), 'hex');
  }
}

async function withBatchLock(stateDir, batchId, action) {
  const lockPath = `${batchFile(stateDir, batchId)}.lock`;
  let handle;
  for (let attempt = 0; attempt < 200 && !handle; attempt += 1) {
    try { handle = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  if (!handle) fail('Could not lock the review batch. Try again.');
  try { return await action(); }
  finally {
    await handle.close();
    await unlink(lockPath).catch(() => {});
  }
}

function newBatchId(now) {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `rb-${day}-${randomBytes(4).toString('hex')}`;
}
function newCode() {
  const letters = [0, 1, 2].map(() => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
  return `${letters}-${String(randomInt(100)).padStart(2, '0')}`;
}
export const approvalPhrase = (batch) => `APPROVE ${batch.code}`;
const normalizePhrase = (value) => String(value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

export function effectiveStatus(batch, now = new Date()) {
  if (batch.status === 'pending' && Date.parse(batch.pendingExpiresAt) <= now.getTime()) return 'expired';
  if (batch.status === 'approved' && Date.parse(batch.expiresAt) <= now.getTime()) return 'expired';
  return batch.status;
}

function macPayload(batch) {
  const approved = new Set(batch.approvedItemIds);
  return stableJson({
    v: 1,
    batchId: batch.batchId,
    approvedAt: batch.approvedAt,
    expiresAt: batch.expiresAt,
    channel: batch.approvalChannel,
    resumeSha256: batch.resume?.sha256 ?? null,
    items: batch.items.filter((item) => approved.has(item.itemId)).map((item) => ({
      itemId: item.itemId, key: itemKey(item), url: item.url ?? null,
      answersSha256: item.answersSha256 ?? null, textSha256: item.textSha256 ?? null,
    })),
  });
}
const macFor = (secret, batch) => createHmac('sha256', secret).update(macPayload(batch)).digest('base64url');
const tokenFor = (batch, mac) => `${TOKEN_PREFIX}.${batch.batchId}.${mac}`;

export async function loadBatch(stateDir, batchId) {
  try { return JSON.parse(await readFile(batchFile(stateDir, batchId), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') fail('Unknown review batch ID.');
    throw error;
  }
}

function resumeLabel(resume) {
  if (!resume?.sha256) return 'No canonical résumé imported';
  const kb = Number.isInteger(resume.bytes) ? `, ${Math.max(1, Math.round(resume.bytes / 1024))} KB` : '';
  return `Canonical résumé (sha256 ${resume.sha256.slice(0, 12)}${kb})`;
}

export function renderTable(batch) {
  const rows = batch.items.map((item) => (item.type === 'email'
    ? `${item.number}. EMAIL  ${item.company} to ${item.to}${item.subject ? ` | subject: ${item.subject}` : ''}${item.attachResume ? ' | résumé attached' : ''} (draft revision ${item.draftRevision}, ${item.text.length} characters)`
    : `${item.number}. ${item.purpose === 'retry' ? 'RETRY' : 'APPLY'}  ${item.company} | ${item.role} | ${item.url} | fit ${item.fitScore}${item.ats ? ` | ${item.ats}` : ''} | ${Object.keys(item.answers).length} answers${item.flaggedAnswers.length ? ` (flagged: ${item.flaggedAnswers.map((f) => `${f.answer}: ${f.reason}`).join('; ')})` : ''}`));
  return [`Review batch ${batch.batchId} (${batch.items.length} item${batch.items.length === 1 ? '' : 's'})`, `Résumé: ${resumeLabel(batch.resume)}`, ...rows].join('\n');
}

export function batchView(batch, now = new Date(), { includeContent = false, token = null } = {}) {
  const status = effectiveStatus(batch, now);
  const approved = new Set(batch.approvedItemIds ?? []);
  return {
    batchId: batch.batchId,
    status,
    createdAt: batch.createdAt,
    ...(status === 'pending' ? { pendingExpiresAt: batch.pendingExpiresAt, approvalPhrase: approvalPhrase(batch) } : {}),
    ...(batch.approvedAt ? { approvedAt: batch.approvedAt, expiresAt: batch.expiresAt, approvalChannel: batch.approvalChannel } : {}),
    ...(batch.decidedAt && batch.status !== 'approved' ? { decidedAt: batch.decidedAt } : {}),
    ...(batch.roundId ? { roundId: batch.roundId } : {}),
    resume: resumeLabel(batch.resume),
    items: batch.items.map((item) => ({
      number: item.number,
      itemId: item.itemId,
      type: item.type,
      company: item.company,
      ...(item.type === 'email'
        ? { opportunityId: item.opportunityId, draftRevision: item.draftRevision, to: item.to, ...(item.subject ? { subject: item.subject } : {}), attachResume: item.attachResume, ...(item.recipient ? { recipient: item.recipient } : {}), ...(includeContent ? { text: item.text } : {}) }
        : { purpose: item.purpose, applicationId: item.applicationId, role: item.role, url: item.url, ats: item.ats, fitScore: item.fitScore, answerCount: Object.keys(item.answers).length, flaggedAnswers: item.flaggedAnswers, ...(includeContent ? { answers: item.answers } : {}) }),
      ...(batch.approvedAt ? { approved: approved.has(item.itemId) } : {}),
      ...(batch.uses?.[item.itemId] ? { usedAt: batch.uses[item.itemId].usedAt } : {}),
    })),
    table: renderTable(batch),
    ...(token && status === 'approved' ? { reviewToken: token } : {}),
  };
}

export async function stageBatch(stateDir, input, { now = new Date(), resume = null } = {}) {
  const { items, roundId } = validateStageInput(input);
  await ensureDir(stateDir);
  await reviewSecret(stateDir);
  const batch = {
    version: 1,
    batchId: newBatchId(now),
    code: newCode(),
    status: 'pending',
    createdAt: now.toISOString(),
    pendingExpiresAt: new Date(now.getTime() + REVIEW_PENDING_TTL_MS).toISOString(),
    ...(roundId ? { roundId } : {}),
    resume: resume?.sha256 ? { sha256: resume.sha256, bytes: resume.bytes ?? null } : null,
    items: items.map((item, index) => ({ itemId: `i${index + 1}`, number: index + 1, ...item })),
    uses: {},
  };
  await writePrivate(batchFile(stateDir, batch.batchId), batch);
  return batch;
}

export async function listBatches(stateDir, now = new Date()) {
  let names = [];
  try { names = await readdir(batchesDir(stateDir)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const batches = [];
  for (const name of names.filter((n) => /^rb-\d{8}-[0-9a-f]{8}\.json$/.test(n)).sort()) {
    try {
      const batch = JSON.parse(await readFile(join(batchesDir(stateDir), name), 'utf8'));
      batches.push({ batchId: batch.batchId, status: effectiveStatus(batch, now), createdAt: batch.createdAt, items: batch.items.length, approved: batch.approvedItemIds?.length ?? 0, used: Object.keys(batch.uses ?? {}).length });
    } catch { /* skip unreadable batch */ }
  }
  return { batches };
}

/**
 * Approve a pending batch. `itemIds` (page) or `excludeNumbers` (chat) select what is approved.
 * The chat channel must carry the exact confirmation phrase the candidate typed.
 */
export async function approveBatch(stateDir, batchId, { channel, phrase, itemIds, excludeNumbers, now = new Date() } = {}) {
  if (!REVIEW_CHANNELS.includes(channel)) fail('Unknown approval channel.');
  return withBatchLock(stateDir, batchId, async () => {
    const batch = await loadBatch(stateDir, batchId);
    const status = effectiveStatus(batch, now);
    if (status !== 'pending') fail(`Review batch is ${status}; stage a new batch.`);
    if (normalizePhrase(phrase) !== approvalPhrase(batch)) fail('The approval phrase does not match this batch. The candidate must type it exactly as shown.');
    let selected;
    if (itemIds != null) {
      if (!Array.isArray(itemIds)) fail('itemIds must be an array.');
      const known = new Set(batch.items.map((item) => item.itemId));
      if (itemIds.some((id) => !known.has(id))) fail('Approval lists an item that is not in this batch.');
      selected = [...new Set(itemIds)];
    } else {
      const exclude = excludeNumbers ?? [];
      if (!Array.isArray(exclude) || exclude.some((n) => !Number.isInteger(n) || n < 1 || n > batch.items.length)) fail(`exclude must list item numbers from 1 to ${batch.items.length}.`);
      selected = batch.items.filter((item) => !exclude.includes(item.number)).map((item) => item.itemId);
    }
    if (!selected.length) fail('Approve at least one item, or reject the batch instead.');
    const order = new Map(batch.items.map((item, index) => [item.itemId, index]));
    batch.approvedItemIds = selected.sort((a, b) => order.get(a) - order.get(b));
    batch.status = 'approved';
    batch.approvedAt = now.toISOString();
    batch.expiresAt = new Date(now.getTime() + REVIEW_APPROVAL_TTL_MS).toISOString();
    batch.approvalChannel = channel;
    batch.mac = macFor(await reviewSecret(stateDir), batch);
    await writePrivate(batchFile(stateDir, batchId), batch);
    return { batch, token: tokenFor(batch, batch.mac) };
  });
}

export async function closeBatch(stateDir, batchId, outcome, { now = new Date() } = {}) {
  if (!['rejected', 'revoked'].includes(outcome)) fail('Unknown batch outcome.');
  return withBatchLock(stateDir, batchId, async () => {
    const batch = await loadBatch(stateDir, batchId);
    const status = effectiveStatus(batch, now);
    if (outcome === 'rejected' && status !== 'pending') fail(`Review batch is ${status}.`);
    if (outcome === 'revoked' && !['pending', 'approved'].includes(status)) fail(`Review batch is ${status}.`);
    batch.status = outcome;
    batch.decidedAt = now.toISOString();
    await writePrivate(batchFile(stateDir, batchId), batch);
    return batch;
  });
}

export async function batchToken(stateDir, batch, now = new Date()) {
  if (effectiveStatus(batch, now) !== 'approved') return null;
  const mac = macFor(await reviewSecret(stateDir), batch);
  return mac === batch.mac ? tokenFor(batch, mac) : null;
}

function sameToken(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export class ReviewGateError extends Error {}
function gate(message) { throw new ReviewGateError(message); }

const STAGE_HINT = 'Stage it with `review stage --stdin`, have the candidate approve the batch on the review page (`review open <batchId>`) or by typing its approval phrase in chat (`review approve --stdin`), then pass `reviewBatchId` and `reviewToken`.';

/**
 * Find the approved, unused item that covers this send. `match(item)` returns true for the
 * item that describes it, or a string explaining what changed since approval.
 */
export async function verifyReview(stateDir, { reviewBatchId, reviewToken }, { action, match, resumeSha256, checkResume = false, now = new Date() }) {
  if (reviewBatchId == null || reviewToken == null) gate(`${action} needs a batch approval from the candidate. ${STAGE_HINT}`);
  if (typeof reviewToken !== 'string' || !reviewToken.startsWith(`${TOKEN_PREFIX}.${reviewBatchId}.`)) gate('reviewToken does not belong to reviewBatchId.');
  let batch;
  try { batch = await loadBatch(stateDir, reviewBatchId); } catch { gate('Unknown review batch ID.'); }
  const status = effectiveStatus(batch, now);
  if (status !== 'approved') gate(`Review batch ${reviewBatchId} is ${status}. ${STAGE_HINT}`);
  const expected = macFor(await reviewSecret(stateDir), batch);
  if (!batch.mac || !sameToken(expected, batch.mac) || !sameToken(reviewToken, tokenFor(batch, expected))) gate('reviewToken is not valid for this batch. Do not edit review batches; stage a new one.');
  const approved = new Set(batch.approvedItemIds);
  const reasons = [];
  for (const item of batch.items) {
    const result = match(item);
    if (result === true) {
      if (!approved.has(item.itemId)) gate(`The candidate removed item ${item.number} (${item.company}) from batch ${reviewBatchId}; it must not be sent.`);
      if (batch.uses?.[item.itemId]) gate(`Item ${item.number} (${item.company}) in batch ${reviewBatchId} was already used at ${batch.uses[item.itemId].usedAt}. Each approval covers one send.`);
      if (checkResume && (batch.resume?.sha256 ?? null) !== (resumeSha256 ?? null)) gate('The canonical résumé changed after the batch was approved. Stage a new batch so the candidate reviews the current résumé.');
      return { batch, item };
    }
    if (typeof result === 'string') reasons.push(`item ${item.number}: ${result}`);
  }
  if (reasons.length) gate(`This send differs from what the candidate approved (${reasons.join('; ')}). Send the item back to the candidate in a new batch.`);
  gate(`Batch ${reviewBatchId} does not cover this send. ${STAGE_HINT}`);
}

export async function consumeReview(stateDir, batchId, itemId, use, { now = new Date() } = {}) {
  return withBatchLock(stateDir, batchId, async () => {
    const batch = await loadBatch(stateDir, batchId);
    if (batch.uses?.[itemId]) gate('This approval was already used.');
    batch.uses = { ...(batch.uses ?? {}), [itemId]: { usedAt: now.toISOString(), use } };
    await writePrivate(batchFile(stateDir, batchId), batch);
    return batch.uses[itemId];
  });
}

function sameUrl(a, b) {
  try { return canonicalUrl(a) === canonicalUrl(b); } catch { return false; }
}

/** Matcher for `ledger add` / `cloud intent-prepare` / `ledger retry`. */
export function applicationMatcher({ applicationId, url, answers, purpose = 'submit' }) {
  return (item) => {
    if (item.type !== 'application' || item.purpose !== purpose || item.applicationId !== applicationId) return false;
    if (url != null && !sameUrl(item.url, url)) return 'the URL changed';
    if (answers !== undefined && answersDigest(answers) !== item.answersSha256) return 'the answers changed';
    return true;
  };
}

/** Matcher for `outreach handoff`. Draft revisions are immutable, so revision binds the text. */
export function emailMatcher({ opportunityId, draftRevision }) {
  return (item) => {
    if (item.type !== 'email' || item.opportunityId !== opportunityId) return false;
    if (item.draftRevision !== draftRevision) return `the draft revision changed (approved ${item.draftRevision})`;
    return true;
  };
}

export async function resumeDigest(file) {
  try {
    const bytes = await readFile(file);
    return { sha256: sha256(bytes), bytes: bytes.length };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** One-line notice for grants written before batch review (they carried `submit`). */
export const LEGACY_GRANT_NOTICE = 'Notice: your autonomy grant no longer covers submitting or sending on its own. Every send now needs a batch approval from you (review page or approval phrase). Discovery, assessment and form filling still run under the grant.\n';
