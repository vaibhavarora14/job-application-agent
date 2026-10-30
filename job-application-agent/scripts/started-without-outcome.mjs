// Jobs `score` sent to review (the moment `application_started` is emitted) that never got a
// submit (ledger entry), skip (skip record) or pause (attention item). `round status` and
// `round complete` list them so the agent reports them in the round summary (#222).
//
// The record lives only in the private state directory (review-started.json): job key hash,
// URL, company, title and score times. It is never sent to telemetry, the community relay or
// cloud state, and nothing here changes telemetry.
import { assessmentJobKey } from './assessment-guard.mjs';

export const REVIEW_STARTED_FILE = 'review-started.json';
export const MAX_LISTED_STARTED_JOBS = 50;

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
  jobs[key] = {
    url: clip(job.url, 2048) ?? previous?.url ?? null,
    company: clip(job.company, 200) ?? previous?.company ?? null,
    title: clip(job.title ?? job.role, 300) ?? previous?.title ?? null,
    firstScoredAt: previous?.firstScoredAt ?? at,
    lastScoredAt: at,
  };
  return { version: 1, jobs };
}

/**
 * Review-scored jobs whose score times overlap the round window and that have no outcome.
 * Outcomes count at any time: a ledger entry (any status), a skip record, an attention item
 * (open or resolved), or a later non-review decision.
 */
export function startedWithoutOutcome({ started, applications = [], attentionEvents = [], skips = null, decisions = null, startedAt, completedAt = null }) {
  const jobs = started?.jobs && typeof started.jobs === 'object' ? started.jobs : {};
  const from = ms(startedAt);
  const to = completedAt ? ms(completedAt) : Infinity;
  const outcomeKeys = new Set();
  const add = (job) => { const key = assessmentJobKey(job); if (key) outcomeKeys.add(key); };
  for (const entry of applications) { add({ url: entry?.url }); add({ company: entry?.company, title: entry?.role ?? entry?.title }); }
  for (const event of attentionEvents) if (event?.type === 'opened') add({ url: event.url });
  for (const key of Object.keys(skips?.jobs ?? {})) outcomeKeys.add(key);
  const list = [];
  for (const [key, record] of Object.entries(jobs)) {
    const first = ms(record?.firstScoredAt);
    const last = ms(record?.lastScoredAt) ?? first;
    if (from == null || first == null || first > to || last < from) continue;
    const latest = decisions?.jobs?.[key];
    if (latest && latest.decision !== 'review') continue;
    const keys = [key, assessmentJobKey({ url: record.url }), assessmentJobKey({ company: record.company, title: record.title })].filter(Boolean);
    if (keys.some((k) => outcomeKeys.has(k))) continue;
    list.push({ company: record.company, role: record.title, url: record.url, scoredAt: record.lastScoredAt ?? record.firstScoredAt });
  }
  list.sort((a, b) => String(a.scoredAt).localeCompare(String(b.scoredAt)));
  return { count: list.length, jobs: list.slice(0, MAX_LISTED_STARTED_JOBS), ...(list.length > MAX_LISTED_STARTED_JOBS ? { truncated: true } : {}) };
}

export function startedWithoutOutcomeWarning(summary) {
  if (!summary?.count) return null;
  return `${summary.count} ${summary.count === 1 ? 'job was' : 'jobs were'} scored for review in this round with no submit, skip or pause (startedWithoutOutcome). Report ${summary.count === 1 ? 'it' : 'them'} to the candidate in the round summary as not pursued; do not apply to ${summary.count === 1 ? 'it' : 'them'} after the round without a new review.`;
}
