import { upsertApplication } from './apply/applications.mjs';
import { homePiles, openAttention } from './attention.mjs';
import { nowIso, openDb } from './db.mjs';
import { assessJob, resumeHash, resumeTextFromProfile } from './llm.mjs';
import { enqueue } from './queue.mjs';
import { remainingSlots } from './round.mjs';
import { getProfile, ledgerCheck, scoreJob } from './skill.mjs';

function parseLocations(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function assessQueuedJob(jobId, { roundId = null, env = process.env, fetchImpl = fetch } = {}) {
  const db = openDb(env);
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job) return { skipped: true, reason: 'missing-job' };

  const stored = getProfile(env);
  if (!stored.configured) {
    openAttention({
      jobId,
      url: job.url,
      stage: 'assessment',
      blocker: 'judgment',
      instructions: 'Profile is incomplete. Finish onboarding before jobs can be scored.',
      env,
    });
    return { skipped: true, reason: 'profile-incomplete' };
  }

  const resumeText = resumeTextFromProfile(stored.profile, stored.extras);
  const hash = resumeHash(`${resumeText}|${(stored.profile.skills || []).join(',')}|${stored.resumePath || ''}`);
  const cached = db.prepare('SELECT * FROM assessments WHERE job_id = ?').get(jobId);
  if (cached && cached.decision !== 'pending_llm') {
    const payload = safeJson(cached.payload_json);
    if (payload.resumeHash === hash) {
      return { cached: true, decision: cached.decision, autoEligible: Boolean(cached.auto_eligible) };
    }
  }

  const llm = await assessJob({
    job,
    resumeText,
    profile: stored.profile,
    env,
    fetchImpl,
  });

  if (llm.pendingLlm) {
    db.prepare(
      `INSERT INTO assessments (job_id, decision, score, auto_eligible, must_have_coverage, payload_json, result_json, provider, created_at)
       VALUES (?, 'pending_llm', NULL, 0, NULL, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         decision = 'pending_llm',
         payload_json = excluded.payload_json,
         result_json = excluded.result_json,
         provider = excluded.provider,
         created_at = excluded.created_at`
    ).run(jobId, JSON.stringify({ resumeHash: hash, llm }), JSON.stringify({ decision: 'pending_llm' }), 'none', nowIso());
    return { pendingLlm: true, jobId };
  }

  const locations = parseLocations(job.locations);
  const scored = scoreJob({
    title: job.title,
    company: job.company,
    description: job.description,
    source: job.application_channel,
    discoverySource: job.discovery_source,
    applicationChannel: job.application_channel,
    url: job.url,
    eligibility: llm.eligibility,
    postingStatus: llm.postingStatus,
    seniority: llm.seniority,
    roleFamily: llm.roleFamily,
    workMode: llm.workMode || job.work_mode || 'unspecified',
    locations,
    salaryMaximum: job.salary_maximum,
    salaryCurrency: job.salary_currency,
    mustHaves: llm.mustHaves,
  }, stored.profile);

  const ledger = await ledgerCheck({
    id: job.id,
    url: job.url,
    company: job.company,
    role: job.role,
  }, env);

  let decision = scored.decision;
  if (ledger.duplicate) decision = 'skip';

  db.prepare(
    `INSERT INTO assessments (job_id, decision, score, auto_eligible, must_have_coverage, payload_json, result_json, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_id) DO UPDATE SET
       decision = excluded.decision,
       score = excluded.score,
       auto_eligible = excluded.auto_eligible,
       must_have_coverage = excluded.must_have_coverage,
       payload_json = excluded.payload_json,
       result_json = excluded.result_json,
       provider = excluded.provider,
       created_at = excluded.created_at`
  ).run(
    jobId,
    decision,
    scored.score,
    scored.autoEligible ? 1 : 0,
    scored.mustHaveCoverage,
    JSON.stringify({ resumeHash: hash, llm, ledger }),
    JSON.stringify(scored),
    llm.provider,
    nowIso(),
  );

  if (decision === 'ask') {
    openAttention({
      jobId,
      url: job.url,
      stage: 'assessment',
      blocker: 'judgment',
      instructions: `Needs a human look: ${(scored.gaps || []).join(' ') || 'score asked before apply.'}`,
      liveViewUrl: job.url,
      env,
    });
  }

  if (decision === 'review' && remainingSlots(roundId, env) > 0) {
    upsertApplication({ job, roundId, status: 'queued', env });
    enqueue('fill', { jobId, roundId, assessmentDecision: decision }, env);
  }

  return { decision, score: scored.score, autoEligible: scored.autoEligible, provider: llm.provider };
}

export function requeuePendingLlm(env = process.env) {
  const rows = openDb(env).prepare("SELECT job_id FROM assessments WHERE decision = 'pending_llm'").all();
  for (const row of rows) enqueue('assess', { jobId: row.job_id }, env);
  return rows.length;
}

export function statusSnapshot(env = process.env) {
  return homePiles(env);
}

function safeJson(text) {
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}
