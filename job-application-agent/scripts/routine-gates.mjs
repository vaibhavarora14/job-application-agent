// Local-only round and send gates added after a routine-auto round that searched one feed,
// recorded its "coverage" after every submit, and sent jobs whose latest score said `ask`.
//
//   1. Verified source coverage: a `searched` source needs a matching recorded call (a
//      `sources jobs` pull for the community job feed, or `round lead` records for a board), and
//      coverage recorded only after the round's submissions does not count.
//   2. Résumé upload preflight at `round start`, recorded as a `resume-upload-unavailable` blocker.
//   3. Score-decision submit gate for routine-auto `ledger add`.
//
// The evidence lives in the private state directory (round-evidence.ndjson and
// assessment-decisions.json). It holds round IDs, source IDs, job-key hashes, decisions and
// timestamps only, and is never sent to telemetry, the community relay or cloud state.

export const ROUND_EVIDENCE_FILE = 'round-evidence.ndjson';
export const ASSESSMENT_DECISIONS_FILE = 'assessment-decisions.json';
export const ROUND_GATES_VERSION = 1;
export const COMMUNITY_FEED_SOURCE_ID = 'community-jobs-feed';
export const COMMUNITY_FEED_BLOCKERS = Object.freeze(['access-unavailable', 'site-error']);
export const RESUME_UPLOAD_BLOCKER = 'resume-upload-unavailable';
const SUPPLEMENTAL_SOURCES = new Set(['recruiter-inbound', 'user-supplied-leads']);

const ms = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** The gates record for a round, or null for rounds started before the gates (legacy rules apply). */
export function roundGatesRecord(evidence, roundId) {
  return evidence.find((event) => event?.type === 'round-gates' && event.roundId === roundId) ?? null;
}

export function resumePreflightRecord(evidence, roundId) {
  return evidence.filter((event) => event?.type === 'resume-preflight' && event.roundId === roundId).at(-1) ?? null;
}

/** Community feed pulls recorded at or after `sinceMs`. */
export function feedPulls(evidence, sinceMs) {
  return evidence.filter((event) => event?.type === 'community-feed-pull' && ms(event.at) != null && ms(event.at) >= sinceMs);
}

/** Recorded lead times per source for one round (earliest first). */
export function leadTimesBySource(evidence, roundId, leads = []) {
  const times = new Map();
  const recordedIds = new Set();
  const add = (sourceId, at) => {
    const value = ms(at);
    if (value == null) return;
    if (!times.has(sourceId)) times.set(sourceId, []);
    times.get(sourceId).push(value);
  };
  for (const event of evidence) {
    if (event?.type !== 'lead-recorded' || event.roundId !== roundId) continue;
    add(event.sourceId, event.at);
    if (event.leadId) recordedIds.add(event.leadId);
  }
  // Leads that reached this host without a local record (for example from another host through
  // private cloud state) fall back to their observedAt time.
  for (const lead of leads) {
    if (lead?.roundId === roundId && !recordedIds.has(lead.id)) add(lead.sourceId, lead.observedAt);
  }
  for (const list of times.values()) list.sort((a, b) => a - b);
  return times;
}

/**
 * Coverage verification for a gated round. `sourceEvents` are the round's `source-checked`
 * events in order; `submissions` are its counted submissions with the local time they were
 * recorded (`at`).
 */
export function evaluateRoundCoverage({ gates, evidence, roundId, sourceEvents, leads = [], submissions = [], group = (id) => id, minSources = 3 }) {
  const gatesAt = ms(gates.at) ?? 0;
  const submitTimes = submissions.map((item) => ms(item.at)).filter((value) => value != null);
  const lastSubmissionMs = submitTimes.length ? Math.max(...submitTimes) : null;
  const beforeSubmissions = (value) => value != null && (lastSubmissionMs == null || value <= lastSubmissionMs);
  const pulls = feedPulls(evidence, gatesAt);
  const okPulls = pulls.filter((pull) => pull.ok === true).map((pull) => ms(pull.at)).sort((a, b) => a - b);
  const failedPulls = pulls.filter((pull) => pull.ok !== true).map((pull) => ms(pull.at)).sort((a, b) => a - b);
  const leadTimes = leadTimesBySource(evidence, roundId, leads);
  const latest = new Map();
  const searchedEver = new Set();
  const firstBlockedAt = new Map();
  for (const event of sourceEvents) {
    latest.set(event.sourceId, event);
    if (event.status === 'searched') searchedEver.add(event.sourceId);
    else if (!firstBlockedAt.has(event.sourceId) && ms(event.occurredAt) != null) firstBlockedAt.set(event.sourceId, ms(event.occurredAt));
  }

  const sources = [];
  for (const report of latest.values()) {
    if (SUPPLEMENTAL_SOURCES.has(report.sourceId)) continue;
    // Same rule as the round summary: a source searched at any point in the round counts as searched.
    const searchedSource = searchedEver.has(report.sourceId);
    let evidenceAt = null;
    if (report.sourceId === COMMUNITY_FEED_SOURCE_ID) {
      evidenceAt = (searchedSource ? okPulls : failedPulls)[0] ?? null;
    } else if (searchedSource) {
      evidenceAt = leadTimes.get(report.sourceId)?.[0] ?? null;
    } else {
      evidenceAt = firstBlockedAt.get(report.sourceId) ?? null;
    }
    const verification = evidenceAt == null ? 'unverified' : beforeSubmissions(evidenceAt) ? 'verified' : 'after-submissions';
    sources.push({ sourceId: report.sourceId, status: searchedSource ? 'searched' : report.status, verification, ...(evidenceAt != null ? { evidenceAt: new Date(evidenceAt).toISOString() } : {}) });
  }
  const verified = sources.filter((item) => item.verification === 'verified');
  const attempted = new Set(verified.map((item) => group(item.sourceId)));
  const searched = new Set(verified.filter((item) => item.status === 'searched').map((item) => group(item.sourceId)));
  const okBefore = okPulls.find(beforeSubmissions) ?? null;
  const failedBefore = failedPulls.find(beforeSubmissions) ?? null;
  const feedReport = latest.get(COMMUNITY_FEED_SOURCE_ID);
  const blockerRecorded = feedReport?.status === 'blocked' && !searchedEver.has(COMMUNITY_FEED_SOURCE_ID) && failedBefore != null;
  return {
    enforced: true,
    gatesVersion: gates.version ?? ROUND_GATES_VERSION,
    lastSubmissionAt: lastSubmissionMs == null ? null : new Date(lastSubmissionMs).toISOString(),
    sources,
    unverifiedSourceIds: sources.filter((item) => item.verification === 'unverified').map((item) => item.sourceId),
    afterSubmissionSourceIds: sources.filter((item) => item.verification === 'after-submissions').map((item) => item.sourceId),
    verifiedAttemptedSourceCount: attempted.size,
    verifiedSearchedSourceCount: searched.size,
    coverageSatisfied: attempted.size >= minSources && searched.size > 0,
    communityFeed: {
      sourceId: COMMUNITY_FEED_SOURCE_ID,
      pulled: okBefore != null,
      ...(okPulls.length ? { lastPullAt: new Date(okPulls.at(-1)).toISOString() } : {}),
      ...(failedPulls.length ? { failedPullAt: new Date(failedPulls.at(-1)).toISOString() } : {}),
      blockerRecorded,
      satisfied: okBefore != null || blockerRecorded,
    },
  };
}

export function communityFeedRequirementMessage() {
  return 'Round requires at least one community job feed pull per round, made before the round\'s submissions: run `sources jobs` and review its leads. '
    + `If that call itself failed, record it with round source --stdin as {"sourceId":"${COMMUNITY_FEED_SOURCE_ID}","status":"blocked","blocker":"access-unavailable"} (community feed unavailable).`;
}

export function afterSubmissionCoverageMessage(sourceIds, lastSubmissionAt) {
  return `Round coverage refused: ${sourceIds.join(', ')} ${sourceIds.length === 1 ? 'was' : 'were'} recorded only after the round's last submission (${lastSubmissionAt}). `
    + 'Coverage counts only when the search (its round lead records or sources jobs pull) happened before applying. '
    + 'Search and record sources before submitting; coverage recorded after the fact does not complete a round.';
}

/** Latest local score decision for a job, from the durable decisions file or the assessment guard. */
export function latestAssessmentDecision(keys, { decisions = null, guard = null } = {}) {
  const candidates = [];
  for (const key of keys) {
    const durable = decisions?.jobs?.[key];
    if (durable && typeof durable === 'object' && typeof durable.decision === 'string') candidates.push({ decision: durable.decision, autoEligible: durable.autoEligible === true, score: durable.score ?? null, at: durable.at ?? null });
    const cached = guard?.jobs?.[key];
    if (cached?.result && typeof cached.result.decision === 'string') candidates.push({ decision: cached.result.decision, autoEligible: cached.result.autoEligible === true, score: cached.result.score ?? null, at: cached.lastAt ?? null });
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => (ms(b.at) ?? 0) - (ms(a.at) ?? 0))[0];
}

/** Refusal message for a routine-auto send whose latest decision is not review + autoEligible, else null. */
export function routineSubmitGateMessage(decision, company) {
  if (decision?.decision === 'review' && decision.autoEligible === true) return null;
  const what = decision == null
    ? 'no score decision is recorded for this job'
    : decision.decision === 'review'
      ? `the latest score decision is "review" but autoEligible is false (score ${decision.score ?? 'unknown'})`
      : `the latest score decision is "${decision.decision}"`;
  return `Routine-auto submit refused for ${company || 'this job'}: ${what}. In routine-auto only jobs whose latest score is "review" with autoEligible: true can be sent from a routine batch. `
    + 'Do not submit it as routine work; tell the candidate. To send it anyway, stage it alone in its own review batch (one application) so the candidate approves this job individually, then retry ledger add with that batch\'s reviewBatchId and reviewToken.';
}

/** A one-application review batch is the candidate's per-job approval. */
export function isPerJobApproval(batch) {
  return Array.isArray(batch?.items) && batch.items.length === 1 && batch.items[0]?.type === 'application';
}
