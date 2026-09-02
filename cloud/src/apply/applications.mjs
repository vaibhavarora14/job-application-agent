import { nowIso, openDb } from '../db.mjs';
import { ledgerAdd, ledgerCheck } from '../skill.mjs';

export function upsertApplication({ job, roundId = null, status = 'queued', env = process.env }) {
  const db = openDb(env);
  const existing = db.prepare('SELECT * FROM applications WHERE id = ? OR url = ?').get(job.id, job.url);
  if (existing) {
    db.prepare('UPDATE applications SET status = ?, round_id = COALESCE(?, round_id), updated_at = ? WHERE id = ?')
      .run(status, roundId, nowIso(), existing.id);
    return existing.id;
  }
  db.prepare(
    `INSERT INTO applications (id, job_id, round_id, status, url, company, role, confirmation_url, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
  ).run(job.id, job.id, roundId, status, job.url, job.company, job.role, nowIso());
  return job.id;
}

export function setApplicationStatus(id, status, extra = {}, env = process.env) {
  openDb(env).prepare(
    'UPDATE applications SET status = ?, confirmation_url = COALESCE(?, confirmation_url), updated_at = ? WHERE id = ?'
  ).run(status, extra.confirmationUrl ?? null, nowIso(), id);
}

export async function markSubmitted({
  applicationId,
  job,
  score = 0,
  approval,
  confirmationUrl,
  confirmationExcerpt,
  env = process.env,
}) {
  const check = await ledgerCheck({ id: applicationId, url: job.url, company: job.company, role: job.role }, env);
  if (check.duplicate) return { ok: false, reason: 'duplicate' };
  await ledgerAdd({
    id: applicationId,
    company: job.company,
    role: job.role,
    url: job.url,
    source: job.application_channel || job.applicationChannel || 'greenhouse',
    score: Number.isInteger(score) ? score : 0,
    status: 'submitted',
    submittedAt: nowIso(),
    approval,
    answers: { confirmation: String(confirmationExcerpt || '').slice(0, 200) },
    employerJobId: job.employer_job_id || undefined,
    discoverySource: job.discovery_source || 'direct-company',
    applicationChannel: job.application_channel || undefined,
  }, env);
  setApplicationStatus(applicationId, 'submitted', { confirmationUrl }, env);
  return { ok: true };
}
