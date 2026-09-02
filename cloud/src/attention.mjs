import { randomUUID } from 'node:crypto';

import { nowIso, openDb } from './db.mjs';
import { enqueue } from './queue.mjs';

const BLOCKERS = new Set([
  'authentication', 'mfa', 'captcha', 'legal-attestation', 'demographic', 'government-id',
  'ambiguous-authorization', 'ambiguous-compensation', 'unverifiable-claim', 'judgment',
  'video', 'upload', 'site-error', 'other',
]);
const STAGES = new Set([
  'discovery', 'assessment', 'application', 'contact', 'resume', 'questions', 'legal',
  'demographic', 'review', 'submission', 'confirmation', 'outcome', 'answers', 'upload',
]);

export function openAttention({
  applicationId = null,
  jobId = null,
  url,
  stage,
  blocker,
  instructions,
  liveViewUrl = null,
  env = process.env,
} = {}) {
  if (!STAGES.has(stage)) throw new Error(`attention.stage is invalid: ${stage}`);
  if (!BLOCKERS.has(blocker)) throw new Error(`attention.blocker is invalid: ${blocker}`);
  const db = openDb(env);
  const existing = db.prepare(
    `SELECT id FROM attention WHERE status = 'open' AND blocker = ? AND IFNULL(job_id,'') = IFNULL(?, '')`
  ).get(blocker, jobId);
  if (existing) return existing.id;
  const id = `attention-${randomUUID()}`;
  db.prepare(
    `INSERT INTO attention (id, application_id, job_id, url, stage, blocker, instructions, live_view_url, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
  ).run(id, applicationId, jobId, url, stage, blocker, instructions, liveViewUrl, nowIso());
  return id;
}

export function listOpenAttention(env = process.env) {
  return openDb(env).prepare(
    `SELECT a.*, j.title AS job_title, j.company AS job_company
     FROM attention a
     LEFT JOIN jobs j ON j.id = a.job_id
     WHERE a.status = 'open'
     ORDER BY a.created_at DESC`
  ).all();
}

export function resolveAttention(id, { note = '', resumeFill = false, env = process.env } = {}) {
  const db = openDb(env);
  const row = db.prepare('SELECT * FROM attention WHERE id = ?').get(id);
  if (!row) throw new Error(`attention ${id} not found`);
  db.prepare('UPDATE attention SET status = ?, resolved_at = ? WHERE id = ?')
    .run(note ? `resolved:${note.slice(0, 80)}` : 'resolved', nowIso(), id);
  if (resumeFill && row.job_id) {
    enqueue('fill', { jobId: row.job_id, afterAttention: id }, env);
  }
  return { ok: true, id };
}

export function homePiles(env = process.env) {
  const db = openDb(env);
  const sent = db.prepare(
    `SELECT a.id, a.status, a.confirmation_url, a.updated_at, a.company, a.role, a.url
     FROM applications a
     WHERE a.status IN ('submitted', 'confirmed')
     ORDER BY a.updated_at DESC`
  ).all();
  const needsYou = listOpenAttention(env);
  const working = db.prepare(
    `SELECT a.id, a.status, a.updated_at, a.company, a.role, a.url
     FROM applications a
     WHERE a.status IN ('queued', 'filling', 'ready')
     ORDER BY a.updated_at DESC`
  ).all();
  const queue = db.prepare(
    `SELECT type, status, COUNT(*) AS n FROM work_queue WHERE status IN ('queued', 'running') GROUP BY type, status`
  ).all();
  return { sent, needsYou, working, queue };
}
