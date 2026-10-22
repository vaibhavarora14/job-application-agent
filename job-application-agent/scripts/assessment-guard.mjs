// Local guard against runaway `score` loops.
//
// Every `score --stdin` call is a separate CLI process, so an agent (or a script it wrote) that
// pipes job after job into the CLI cannot be stopped from inside one process. The guard keeps a
// small rolling-window state file in the private state directory and, across invocations:
//   - caps new assessments per rolling window (default 200 per 6 hours);
//   - never re-scores identical input for the same job inside the window (returns the earlier
//     result without emitting telemetry) and refuses a job after a few attempts;
//   - backs off exponentially after invalid input and hard-stops after N consecutive
//     invalid-input failures (default 5) with a message that says to stop and what to fix.
// The state holds job keys (hashes), input digests, timestamps and the last decision only.

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const ASSESSMENT_GUARD_FILE = 'assessment-guard.json';
export const ASSESSMENT_GUARD_STREAM = 'assessment-guard';

export const ASSESSMENT_GUARD_DEFAULTS = Object.freeze({
  maxAssessments: 200,
  windowMinutes: 360,
  maxPerJob: 3,
  maxConsecutiveInvalid: 5,
  maxConsecutiveRepeats: 20,
  stopMinutes: 30,
  backoffBaseMs: 1_000,
  backoffMaxMs: 30_000,
});

const ENV_KEYS = Object.freeze({
  maxAssessments: ['JOB_APPLICATION_AGENT_MAX_ASSESSMENTS', 1, 100_000],
  windowMinutes: ['JOB_APPLICATION_AGENT_ASSESSMENT_WINDOW_MINUTES', 1, 7 * 24 * 60],
  maxPerJob: ['JOB_APPLICATION_AGENT_MAX_ASSESSMENTS_PER_JOB', 1, 100],
  maxConsecutiveInvalid: ['JOB_APPLICATION_AGENT_MAX_CONSECUTIVE_INVALID', 1, 1_000],
  maxConsecutiveRepeats: ['JOB_APPLICATION_AGENT_MAX_CONSECUTIVE_REPEATS', 1, 10_000],
  stopMinutes: ['JOB_APPLICATION_AGENT_ASSESSMENT_STOP_MINUTES', 0, 7 * 24 * 60],
  backoffBaseMs: ['JOB_APPLICATION_AGENT_ASSESSMENT_BACKOFF_MS', 0, 60_000],
  backoffMaxMs: ['JOB_APPLICATION_AGENT_ASSESSMENT_BACKOFF_MAX_MS', 0, 300_000],
});

export const GUARD_RESET_COMMAND = 'node scripts/job-application.mjs score guard-reset';
const SCHEMA_HINT = 'Each job needs non-empty title, company and description (at most 40000 characters), a valid source and eligibility; see references/SCHEMAS.md.';

/** Guard limits from the environment, falling back to defaults for missing or invalid values. */
export function assessmentGuardConfig(env = process.env) {
  const config = { ...ASSESSMENT_GUARD_DEFAULTS };
  for (const [key, [name, min, max]] of Object.entries(ENV_KEYS)) {
    const raw = env?.[name];
    if (raw == null || String(raw).trim() === '') continue;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= min && value <= max) config[key] = value;
  }
  if (config.backoffMaxMs < config.backoffBaseMs) config.backoffMaxMs = config.backoffBaseMs;
  return config;
}

/** Exponential backoff before the next score call after `consecutive` invalid-input failures. */
export function invalidInputBackoffMs(consecutive, config = ASSESSMENT_GUARD_DEFAULTS) {
  if (!Number.isInteger(consecutive) || consecutive < 1 || config.backoffBaseMs <= 0) return 0;
  return Math.min(config.backoffMaxMs, config.backoffBaseMs * 2 ** Math.min(consecutive - 1, 20));
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function normalizedJobUrl(value) {
  try {
    const url = new URL(String(value));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (!/^(job|jobid|jid|gh_jid|requisition|requisitionid|reqid|posting|postingid|position|positionid|vacancy|vacancyid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Stable key for "the same job": its normalized URL, else company + title. Null when neither exists. */
export function assessmentJobKey(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return null;
  const url = typeof job.url === 'string' && job.url.trim() ? normalizedJobUrl(job.url.trim()) : null;
  if (url) return sha256(`url:${url}`);
  const company = typeof job.company === 'string' ? job.company.trim().toLowerCase() : '';
  const title = typeof job.title === 'string' ? job.title.trim().toLowerCase() : '';
  if (!company && !title) return null;
  return sha256(`job:${company}\n${title}`);
}

/** Digest of everything that can change a score: the job JSON and the target profile. */
export function assessmentInputDigest(job, target) {
  return sha256(JSON.stringify(canonical({ job, target: target ?? null })));
}

function emptyState() {
  return { version: 1, assessments: [], jobs: {}, invalid: { consecutive: 0, lastAt: null, lastMessage: null }, repeats: 0, stop: null };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return state;
  if (Array.isArray(raw.assessments)) state.assessments = raw.assessments.filter((row) => row && typeof row.at === 'string');
  if (raw.jobs && typeof raw.jobs === 'object' && !Array.isArray(raw.jobs)) state.jobs = raw.jobs;
  if (raw.invalid && typeof raw.invalid === 'object') {
    state.invalid = {
      consecutive: Number.isInteger(raw.invalid.consecutive) && raw.invalid.consecutive > 0 ? raw.invalid.consecutive : 0,
      lastAt: typeof raw.invalid.lastAt === 'string' ? raw.invalid.lastAt : null,
      lastMessage: typeof raw.invalid.lastMessage === 'string' ? raw.invalid.lastMessage : null,
    };
  }
  if (Number.isInteger(raw.repeats) && raw.repeats > 0) state.repeats = raw.repeats;
  if (raw.stop && typeof raw.stop === 'object' && typeof raw.stop.until === 'string') state.stop = raw.stop;
  return state;
}

function prune(state, nowMs, config) {
  const cutoff = nowMs - config.windowMinutes * 60_000;
  state.assessments = state.assessments.filter((row) => Date.parse(row.at) > cutoff);
  for (const [key, job] of Object.entries(state.jobs)) {
    if (!job || typeof job !== 'object' || !(Date.parse(job.lastAt) > cutoff)) delete state.jobs[key];
  }
  if (state.stop && !(Date.parse(state.stop.until) > nowMs)) state.stop = null;
  return state;
}

function shortMessage(message) {
  return String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function formatUntil(iso) {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** Error raised when the guard refuses a score call. Classified as rate_limited, never invalid_input. */
export class AssessmentGuardStop extends Error {
  constructor(message, { reason, until = null, suppressTelemetry = false } = {}) {
    super(message);
    this.name = 'AssessmentGuardStop';
    this.assessmentGuard = true;
    this.reason = reason;
    this.until = until;
    this.telemetryErrorCode = 'rate_limited';
    this.telemetryErrorCategory = 'other';
    this.suppressTelemetry = suppressTelemetry;
  }
}

export function isAssessmentGuardStop(error) {
  return error?.assessmentGuard === true;
}

function stopMessage(stop, config) {
  const until = formatUntil(stop.until);
  const resume = `Assessments resume after ${until}, or sooner if the user runs \`${GUARD_RESET_COMMAND}\` after the fix.`;
  if (stop.reason === 'invalid_input') {
    return `Assessment guard stop: ${stop.count} score calls in a row failed with invalid input. STOP the run now; do not retry, loop, or move on to more jobs. `
      + `Last error: ${stop.lastMessage || 'invalid job input'} Fix how the job JSON is built before calling score again. ${SCHEMA_HINT} `
      + `Tell the user what failed. ${resume}`;
  }
  if (stop.reason === 'cap') {
    return `Assessment guard stop: ${config.maxAssessments} jobs were already assessed in the last ${config.windowMinutes} minutes, the limit for one run. STOP assessing now. `
      + 'Do not re-run discovery or score more jobs; act on the jobs already assessed (apply, pause, or skip them) and report to the user. '
      + `If the user really wants a larger run, they can raise JOB_APPLICATION_AGENT_MAX_ASSESSMENTS. ${resume}`;
  }
  return `Assessment guard stop: ${stop.count} score calls in a row were repeats of jobs already assessed in this run. STOP the loop now; the same jobs are being scored again. `
    + 'Use the earlier score results instead of re-scoring, keep a list of jobs already assessed, and tell the user. '
    + `${resume}`;
}

export function createAssessmentGuard({ dir, withLock, env = process.env, now = () => new Date(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const config = assessmentGuardConfig(env);
  const file = () => join(dir(), ASSESSMENT_GUARD_FILE);

  async function load() {
    try { return normalizeState(JSON.parse(await readFile(file(), 'utf8'))); } catch { return emptyState(); }
  }

  async function mutate(action, write) {
    return withLock(ASSESSMENT_GUARD_STREAM, async () => {
      const state = prune(await load(), now().getTime(), config);
      let result;
      try {
        result = await action(state);
      } catch (error) {
        // Refusals still persist their bookkeeping (stop records, attempt counts, notified flags).
        await write(file(), state);
        throw error;
      }
      await write(file(), state);
      return result;
    });
  }

  function view(state) {
    const nowMs = now().getTime();
    return {
      limit: config.maxAssessments,
      used: state.assessments.length,
      remaining: Math.max(0, config.maxAssessments - state.assessments.length),
      windowMinutes: config.windowMinutes,
      maxPerJob: config.maxPerJob,
      consecutiveInvalidInput: state.invalid.consecutive,
      maxConsecutiveInvalidInput: config.maxConsecutiveInvalid,
      stopped: Boolean(state.stop && Date.parse(state.stop.until) > nowMs),
      ...(state.stop ? { stopReason: state.stop.reason, stoppedUntil: state.stop.until } : {}),
    };
  }

  function setStop(state, reason, count, extra = {}) {
    const nowMs = now().getTime();
    let untilMs = nowMs + config.stopMinutes * 60_000;
    // The cap lifts when the oldest assessment leaves the window, never earlier.
    if (reason === 'cap' && state.assessments.length) {
      untilMs = Math.max(untilMs, Date.parse(state.assessments[0].at) + config.windowMinutes * 60_000);
    }
    state.stop = { reason, count, at: new Date(nowMs).toISOString(), until: new Date(untilMs).toISOString(), notified: false, ...extra };
    return state.stop;
  }

  function refuse(state) {
    const first = state.stop.notified !== true;
    state.stop.notified = true;
    return new AssessmentGuardStop(stopMessage(state.stop, config), { reason: state.stop.reason, until: state.stop.until, suppressTelemetry: !first });
  }

  return {
    config,

    async status(write) {
      return mutate((state) => view(state), write);
    },

    async reset(write) {
      return mutate((state) => {
        Object.assign(state, emptyState());
        return { reset: true, ...view(state) };
      }, write);
    },

    /**
     * Call before scoring. Waits out invalid-input backoff, then either throws an
     * AssessmentGuardStop, returns { cached } for identical repeat input, or reserves a slot.
     */
    async before(job, target, write) {
      const snapshot = prune(await load(), now().getTime(), config);
      if (!snapshot.stop && snapshot.invalid.consecutive > 0 && snapshot.invalid.lastAt) {
        const wait = Date.parse(snapshot.invalid.lastAt) + invalidInputBackoffMs(snapshot.invalid.consecutive, config) - now().getTime();
        if (wait > 0) await sleep(Math.min(wait, config.backoffMaxMs));
      }
      const jobKey = assessmentJobKey(job);
      const digest = assessmentInputDigest(job, target);
      return mutate((state) => {
        if (state.stop) throw refuse(state);
        const at = now().toISOString();
        const record = jobKey ? state.jobs[jobKey] : null;
        if (record) {
          record.attempts = (record.attempts ?? 0) + 1;
          record.lastAt = at;
          if (record.digest === digest && record.result) {
            state.repeats += 1;
            if (state.repeats >= config.maxConsecutiveRepeats) {
              setStop(state, 'repeats', state.repeats);
              throw refuse(state);
            }
            return { cached: record.result, firstAssessedAt: record.firstAt, attempts: record.attempts };
          }
          if (record.attempts > config.maxPerJob) {
            state.repeats += 1;
            if (state.repeats >= config.maxConsecutiveRepeats) {
              setStop(state, 'repeats', state.repeats);
              throw refuse(state);
            }
            const first = record.refusalNotified !== true;
            record.refusalNotified = true;
            throw new AssessmentGuardStop(
              `Assessment guard: this job was already scored ${config.maxPerJob} times in this run. Do not score it again. `
              + 'Use the earlier result; if the candidate supplied new facts, record them and decide with the user instead of re-scoring.',
              { reason: 'same_job', suppressTelemetry: !first },
            );
          }
        }
        if (state.assessments.length >= config.maxAssessments) {
          setStop(state, 'cap', state.assessments.length);
          throw refuse(state);
        }
        const reservation = randomUUID();
        state.assessments.push({ at, id: reservation });
        return { reservation, jobKey, digest };
      }, write);
    },

    /** Record a successful score: clear invalid-input streak and remember the result for repeats. */
    async success(ticket, result, write) {
      return mutate((state) => {
        state.invalid = { consecutive: 0, lastAt: null, lastMessage: null };
        const at = now().toISOString();
        if (ticket?.reservation) {
          state.repeats = 0;
          if (ticket.jobKey) {
            const previous = state.jobs[ticket.jobKey];
            state.jobs[ticket.jobKey] = {
              firstAt: previous?.firstAt ?? at,
              lastAt: at,
              attempts: previous?.attempts ?? 1,
              digest: ticket.digest,
              result: { score: result.score, decision: result.decision, autoEligible: result.autoEligible, mustHaveCoverage: result.mustHaveCoverage, gates: result.gates, reasons: result.reasons, gaps: result.gaps },
            };
          }
        }
        return view(state);
      }, write);
    },

    /** Record a failed score call. Invalid input extends the streak and may trigger the hard stop. */
    async failure(ticket, error, { invalidInput }, write) {
      return mutate((state) => {
        if (ticket?.reservation) state.assessments = state.assessments.filter((row) => row.id !== ticket.reservation);
        if (!invalidInput) return view(state);
        state.invalid = {
          consecutive: state.invalid.consecutive + 1,
          lastAt: now().toISOString(),
          lastMessage: shortMessage(error?.message),
        };
        if (state.invalid.consecutive >= config.maxConsecutiveInvalid && !state.stop) {
          setStop(state, 'invalid_input', state.invalid.consecutive, { lastMessage: state.invalid.lastMessage });
        }
        return view(state);
      }, write);
    },
  };
}
