// Jobs `score` sent to review (the moment `application_started` is emitted) that never got a
// submit (ledger entry), skip (skip record) or pause (attention item). `round status` and
// `round complete` list them so the agent reports them in the round summary (#222).
//
// The record lives only in the private state directory (review-started.json): job key hash,
// URL, company, title and review score times. It is never sent to telemetry, the community relay or
// cloud state, and nothing here changes telemetry.
import { assessmentJobKey } from './assessment-guard.mjs';

export const REVIEW_STARTED_FILE = 'review-started.json';
export const MAX_LISTED_STARTED_JOBS = 50;
const MAX_SCORE_TIMES = 20;

const ms = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const clip = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** Updated review-started state after a `review` decision for `job` at `at`. */
export function noteReviewStarted(state, job, at) {
  const key = assessmentJobKey(job);
  const jobs = state?.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs) ? { ...state.jobs } : {};
  if (!key) return { version: 1, jobs };
  const previous = jobs[key];
  const times = Array.isArray(previous?.scoredAt) ? previous.scoredAt : [];
  jobs[key] = {
    url: clip(job.url, 2048) ?? previous?.url ?? null,
    company: clip(job.company, 200) ?? previous?.company ?? null,
    title: clip(job.title ?? job.role, 300) ?? previous?.title ?? null,
    // Each review score time, newest last, so a round only counts scores made inside it.
    scoredAt: [...times, at].slice(-MAX_SCORE_TIMES),
  };
  return { version: 1, jobs };
}

/**
 * Updated state after `attention add` paused a job. The attention event keeps only the URL, so a
 * job scored without one is matched here by company + title, and the mark stays local.
 */
export function noteReviewPaused(state, { url, company, title }, at) {
  const jobs = state?.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs) ? { ...state.jobs } : {};
  const urlKey = typeof url === 'string' && url.trim() ? assessmentJobKey({ url }) : null;
  const nameKey = assessmentJobKey({ company, title });
  let changed = false;
  for (const [key, record] of Object.entries(jobs)) {
    const matches = record?.url ? urlKey && assessmentJobKey({ url: record.url }) === urlKey : nameKey && key === nameKey;
    if (matches) { jobs[key] = { ...record, pausedAt: at }; changed = true; }
  }
  return { state: { version: 1, jobs }, changed };
}

/**
 * Review-scored jobs scored at least once inside the round window that have no outcome.
 * Outcomes count at any time: a ledger entry (any status), a skip record, an attention item
 * (open or resolved), or a later non-review decision.
 */
export function startedWithoutOutcome({ started, applications = [], attentionEvents = [], skips = null, decisions = null, startedAt, completedAt = null }) {
  const jobs = started?.jobs && typeof started.jobs === 'object' ? started.jobs : {};
  const from = ms(startedAt);
  const to = completedAt ? ms(completedAt) : Infinity;
  // Same identity as score: the URL when the job has one, else company + title. A record with a
  // URL matches outcomes by URL only, so a same-title posting at the same company stays distinct.
  const urlKeys = new Set();
  const nameKeys = new Set();
  const addUrl = (url) => { const key = assessmentJobKey({ url }); if (key) urlKeys.add(key); };
  for (const entry of applications) {
    if (typeof entry?.url === 'string' && entry.url.trim()) addUrl(entry.url);
    const name = assessmentJobKey({ company: entry?.company, title: entry?.role ?? entry?.title });
    if (name) nameKeys.add(name);
  }
  for (const event of attentionEvents) if (event?.type === 'opened') addUrl(event?.url);
  const skipped = new Set(Object.keys(skips?.jobs ?? {}));
  const list = [];
  for (const [key, record] of Object.entries(jobs)) {
    const times = (Array.isArray(record?.scoredAt) ? record.scoredAt : []).filter((time) => { const t = ms(time); return from != null && t != null && t >= from && t <= to; });
    if (!times.length) continue;
    const latest = decisions?.jobs?.[key];
    if (latest && latest.decision !== 'review') continue;
    if (skipped.has(key) || record.pausedAt) continue;
    if (record.url ? urlKeys.has(assessmentJobKey({ url: record.url })) : nameKeys.has(key)) continue;
    list.push({ company: record.company, role: record.title, url: record.url, scoredAt: times.at(-1) });
  }
  list.sort((a, b) => String(a.scoredAt).localeCompare(String(b.scoredAt)));
  return { count: list.length, jobs: list.slice(0, MAX_LISTED_STARTED_JOBS), ...(list.length > MAX_LISTED_STARTED_JOBS ? { truncated: true } : {}) };
}

export function startedWithoutOutcomeWarning(summary) {
  if (!summary?.count) return null;
  return `${summary.count} ${summary.count === 1 ? 'job was' : 'jobs were'} scored for review in this round with no submit, skip or pause (startedWithoutOutcome). Report ${summary.count === 1 ? 'it' : 'them'} to the candidate in the round summary as not pursued; do not apply to ${summary.count === 1 ? 'it' : 'them'} after the round without a new review.`;
}
