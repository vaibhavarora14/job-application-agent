#!/usr/bin/env node

// child_process is used for exactly two local, shell-free spawns (argument arrays, no `shell: true`):
//   1. `review open` starts this package's own review-page.mjs with the current Node binary
//      (process.execPath) to serve the local approval page on 127.0.0.1.
//   2. openBrowser() hands that local review URL to the OS opener (open / xdg-open /
//      `cmd /c start`), only when a desktop is present; JOB_APPLICATION_AGENT_NO_BROWSER=1 turns it off.
// Nothing user- or page-supplied is ever executed.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform, userInfo } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { isEntrypoint } from './entrypoint.mjs';

import { ACCOUNTING_CAPABILITY, accountingApplicationKey, canonicalUrl, deliveryProjection, discoveryProjection, validateDelivery, validateDeliveryReferences, validateLead, validateLeadReferences, stableJson } from './application-accounting.mjs';
import { createSecretStore, migrateLegacyStateDir, resolveStateDir } from './secret-store.mjs';
import { SourceCommunityClient } from './source-community-client.mjs';
import { normalizeCommunityJob, normalizeCommunitySource } from './source-community-schema.mjs';
import { SKILL_VERSION, TelemetryClient } from './telemetry-client.mjs';
import { normalizeCliArgs, usageError, usageFor } from './cli-args.mjs';
import { jobIdentity, sanitizeTelemetryErrorMessage, sanitizeTelemetryFieldLabel } from './telemetry-schema.mjs';
import { CloudStateClient, defaultCloudConfigPath, enableCloudUpdateGuard, saveCloudConfig } from './cloud-state-client.mjs';
import {
  SESSION_BINDING_ATTENTION_KEYS,
  createSessionBinding,
  extractSessionBindingFields,
  sessionBindingPath,
  writeSessionBindingFile,
} from './session-binding.mjs';
import {
  detectAiAssistanceDiscouraged,
  extractNarrativeQuestionsFromText,
  normalizeAttentionQuestions,
} from './attention-questions.mjs';
import { confirmOutreachTowardRound, loadOutreachRoundView, loadSentVerifiedOutreach, outreachConfirmationEvents, projectOutreachRoundCounts, resolveOutreachRoundId } from './outreach-round.mjs';
import { isFixtureOrSandboxApply, resolveApplyKind } from './ats/apply-url-gate.mjs';
import { ASSESSMENT_GUARD_FILE, assessmentJobKey, createAssessmentGuard, invalidJobMessage, isAssessmentGuardStop } from './assessment-guard.mjs';
import {
  ASSESSMENT_DECISIONS_FILE, COMMUNITY_FEED_BLOCKERS, COMMUNITY_FEED_SOURCE_ID, RESUME_UPLOAD_BLOCKER, ROUND_EVIDENCE_FILE, ROUND_GATES_VERSION,
  afterSubmissionCoverageMessage, communityFeedRequirementMessage, evaluateRoundCoverage, feedPulls, isPerJobApproval, latestAssessmentDecision, leadTimesBySource,
  resumePreflightRecord, roundGatesRecord, routineSubmitGateMessage,
} from './routine-gates.mjs';
import { LEGACY_GRANT_NOTICE, applicationMatcher, approveBatch, batchToken, batchView, closeBatch, consumeReview, listBatches, loadBatch, resumeDigest, stageBatch, verifyReview } from './review-batch.mjs';
import { reviewPageInfoFile } from './review-page.mjs';

const SOURCES = new Set(['linkedin', 'greenhouse', 'lever', 'ashby', 'workable', 'comeet', 'workday', 'rippling', 'smartrecruiters', 'google-form', 'company', 'email', 'other']);
/** Ledger applicationChannel values: ATS sources plus honest one-click profile applies (not a community job-board channel). */
const APPLICATION_CHANNELS = new Set([...SOURCES, 'profile_one_click']);
const APPLY_KINDS = new Set(['fixture', 'vendor-sandbox', 'live']);
const DISCOVERY_SOURCES = new Set(['direct-company', 'linkedin', 'x', 'yc', 'hacker-news', 'job-board', 'email', 'user-supplied', 'web-search', 'other']);
const ELIGIBILITY = new Set(['eligible', 'unclear', 'ineligible']);
const POSTING_STATUS = new Set(['active', 'closed', 'unclear']);
const WORK_MODES = new Set(['remote', 'hybrid', 'onsite', 'unspecified']);
const JOB_SENIORITIES = new Set(['junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'founding', 'unspecified']);
const ROLE_FAMILIES = new Set(['frontend', 'backend', 'full-stack', 'product-engineering', 'ai-ml', 'platform', 'infrastructure', 'mobile', 'engineering-management', 'architecture', 'security', 'data', 'other']);
const MUST_HAVE_STATUS = new Set(['met', 'partial', 'missing', 'unclear']);
const INTERVIEW_QUALITIES = new Set(['promising', 'viable', 'weak', 'dead']);
const FAILURE_POINTS = new Set(['role-scope', 'company-problem', 'constraints', 'interviewer', 'process', 'unknown']);
const APPROVALS = new Set(['APPROVE SUBMIT', 'STANDING AUTHORIZATION']);
const MODES = new Set(['review-each', 'routine-auto']);
const TELEMETRY_DURATIONS = new Set(['under-1s', '1-5s', '5-30s', '30-60s', '1-2m', '2-5m', '5-15m', '15m-plus', 'unknown']);
const SUBMISSION_TELEMETRY_ALLOWED = new Set([
  'durationBucket', 'durationMs', 'startedAt', 'endedAt', 'fieldsFilled', 'shortAnswerCount', 'resumeUploaded', 'otpVerified',
  'profileResumeOnFile', 'resumeFieldPresent',
]);
const THIN_OVERRIDE_CONFIRMATION_MIN = 16;
const THIN_OVERRIDE_CONFIRMATION_MAX = 400;
const THIN_OVERRIDE_USES_STREAM = 'thin-submission-override-uses';
const SUBMISSION_TELEMETRY_PII_KEYS = new Set([
  'identity', 'candidateName', 'candidateEmail', 'candidatePhone', 'name', 'email', 'phone',
  'resumePath', 'resume', 'answers', 'answerText', 'fullName', 'firstName', 'lastName',
]);
const FILL_METRICS_SOURCES = new Set(['telemetry', 'answer_keys', 'empty']);
// entryOrigin marks how a submitted ledger entry was produced. 'logged' = recorded after the fact
// without fill telemetry (answer-key fallback), so it is not an agent-filled submission.
// 'agent' is reserved; current clients only ever write/emit 'logged' and omit the key otherwise.
const ENTRY_ORIGINS = new Set(['agent', 'logged']);
export const LOGGED_ENTRY_ORIGIN = 'logged';
// Since 3.8.0 a grant never covers a send on its own: every submission, resend and outreach
// handoff needs a batch approval token (see review-batch.mjs).
const AUTONOMY_SCOPES = Object.freeze(['discover', 'assess', 'fill', 'upload-resume', 'stage-review-batch', 'record-ledger', 'record-outcomes', 'cleanup-tabs', 'open-improvement-pr']);
const LEGACY_SEND_SCOPES = new Set(['submit', 'send-recruiting-email']);
const AUTONOMY_NOTICE_FILE = 'autonomy-batch-review-notice.json';
const AUTONOMY_HARD_STOPS = Object.freeze(['authentication', 'mfa', 'captcha', 'legal-attestation', 'demographic', 'government-id', 'unverifiable-claim', 'ambiguous-authorization', 'ambiguous-compensation']);
const ATTENTION_STAGES = new Set(['discovery', 'assessment', 'application', 'contact', 'resume', 'questions', 'legal', 'demographic', 'review', 'submission', 'confirmation', 'outcome', 'answers', 'upload']);
const ATTENTION_BLOCKERS = new Set(['authentication', 'mfa', 'captcha', 'legal-attestation', 'demographic', 'government-id', 'ambiguous-authorization', 'ambiguous-compensation', 'unverifiable-claim', 'judgment', 'video', 'upload', 'site-error', 'other']);
const REQUIRED_ACTIONS = new Set(['sign-in', 'complete-mfa', 'complete-captcha', 'review-legal', 'choose-demographic', 'provide-government-id', 'provide-authorization', 'provide-compensation', 'verify-claim', 'provide-judgment', 'record-video', 'enable-upload', 'retry-site']);
const COMPANY_REAPPLY_COOLDOWN_DAYS = 15;
const COMPANY_REAPPLY_OVERRIDE = 'CANDIDATE APPROVED EARLY REAPPLICATION';
const SOURCE_CATALOG_URL = new URL('../references/SOURCES.json', import.meta.url);
const SOURCE_CATALOG = JSON.parse(readFileSync(SOURCE_CATALOG_URL, 'utf8'));
if (!Array.isArray(SOURCE_CATALOG)) throw new Error('The packaged source catalog is invalid.');
const SOURCE_CATALOG_IDS = new Set(SOURCE_CATALOG.map((source) => sourceId(source.id, 'source catalog id')));
const MIN_DISCOVERY_SOURCES = 3;
const CONCENTRATION_THRESHOLD = 60;
const SOURCE_BLOCKERS = new Set(['login', 'mfa', 'captcha', 'site-error', 'access-unavailable']);
const CONCENTRATION_REASONS = new Set(['stronger-fit', 'alternatives-exhausted', 'access-blocked', 'candidate-directed']);
const COMMUNITY_SOURCE_ID = /^community-[0-9a-f]{16}$/;
const REQUIRED_PROFILE = ['name', 'email', 'phone', 'location', 'workAuthorization', 'roleFamilies', 'seniority', 'targetLocations', 'workModes', 'submissionMode', 'yearsExperience', 'autoSubmitMinScore', 'manualReviewMinScore', 'minMustHaveCoverage'];
const STRING_PROFILE_FIELDS = new Set(['name', 'email', 'phone', 'location', 'workAuthorization', 'linkedin', 'github', 'portfolio', 'availability', 'currentCompensation', 'targetCompensation', 'submissionMode', 'submissionModeChosenAt']);
const ARRAY_PROFILE_FIELDS = new Set(['roleFamilies', 'seniority', 'skills', 'targetLocations', 'excludedLocations', 'workModes', 'industries', 'excludedCompanies']);
const NUMBER_PROFILE_FIELDS = new Set(['yearsExperience', 'autoSubmitMinScore', 'manualReviewMinScore', 'minMustHaveCoverage']);
const OBJECT_PROFILE_FIELDS = new Set(['compensationFloor']);
const LEGACY_PROFILE_FIELDS = new Set(['salaryPreference']);
const DEFAULT_TARGETING = {
  roleFamilies: ['product-engineering', 'full-stack', 'ai-ml'],
  seniority: ['senior', 'staff'],
  skills: ['TypeScript', 'Python', 'React', 'Node.js', 'PostgreSQL', 'MCP', 'AI agents'],
  targetLocations: ['India', 'Remote', 'Worldwide'],
  workModes: ['remote'],
  industries: ['AI', 'developer tools'],
  submissionMode: 'review-each',
  yearsExperience: 10,
  autoSubmitMinScore: 80,
  manualReviewMinScore: 70,
  minMustHaveCoverage: 70,
};

function stateDir() {
  return resolveStateDir();
}

export const SUBMISSION_MODE_RESET_NOTICE = 'Notice: submissions now default to review-each (you approve every application). Your saved profile had routine-auto without a recorded choice, so it now uses review-each. To turn routine-auto back on, run `profile set --stdin` with "submissionMode": "routine-auto".\n';
const SUBMISSION_MODE_NOTICE_FILE = 'submission-mode-notice.json';

/**
 * routine-auto counts only when the candidate chose it explicitly through `profile set`
 * or `profile migrate`, which stamp `submissionModeChosenAt`. Before 3.7.22, migrations
 * and defaults wrote routine-auto without a marker, so an unstamped routine-auto is
 * indistinguishable from a default and is treated as review-each.
 */
export function normalizeSubmissionMode(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return { profile, reset: false };
  if (profile.submissionMode !== 'routine-auto' || chosenAtValid(profile.submissionModeChosenAt)) return { profile, reset: false };
  const { submissionModeChosenAt: _ignored, ...rest } = profile;
  return { profile: { ...rest, submissionMode: 'review-each' }, reset: true };
}

function chosenAtValid(value) {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));
}

/** Prints the reset notice once per state directory (stderr only; never changes stdout JSON). */
function noticeSubmissionModeReset() {
  try {
    const dir = stateDir();
    const marker = join(dir, SUBMISSION_MODE_NOTICE_FILE);
    if (existsSync(marker)) return;
    process.stderr.write(SUBMISSION_MODE_RESET_NOTICE);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(marker, JSON.stringify({ version: 1, noticedAt: new Date().toISOString() }), { mode: 0o600 });
  } catch { /* A notice failure never blocks a command. */ }
}

function assessmentGuard() {
  return createAssessmentGuard({ dir: stateDir, withLock: withStateLock });
}

const secretStore = createSecretStore({ stateDir });
// Path of the optional cloud-sync config (written only by `cloud configure`). The env override
// exists so tests and smoke runs point at a throwaway file; it never carries a credential itself.
// The config is read locally and sent only to the cloud endpoint the candidate configured.
function cloudConfigPath() {
  return process.env.JOB_APPLICATION_AGENT_CLOUD_CONFIG ?? defaultCloudConfigPath();
}

const cloudState = new CloudStateClient({ stateDir: stateDir(), configPath: cloudConfigPath() });

function cachedCloudProfileRaw() {
  try {
    const config = JSON.parse(readFileSync(cloudConfigPath(), 'utf8'));
    if (config.version !== 2) return null;
    return object(JSON.parse(readFileSync(join(stateDir(), 'cloud-profile-cache.json'), 'utf8')), 'profile');
  } catch {
    return null;
  }
}

export function durationBucket(milliseconds) {
  if (milliseconds < 1_000) return 'under-1s';
  if (milliseconds < 5_000) return '1-5s';
  if (milliseconds < 30_000) return '5-30s';
  if (milliseconds < 60_000) return '30-60s';
  if (milliseconds < 120_000) return '1-2m';
  if (milliseconds < 300_000) return '2-5m';
  if (milliseconds < 900_000) return '5-15m';
  return '15m-plus';
}

export function commandCategory([area, action]) {
  if (area === 'profile' && action === 'set') return 'onboard';
  if (area === 'profile' && action === 'migrate') return 'onboard';
  if (area === 'profile') return 'profile';
  if (area === 'resume') return 'resume';
  if (area === 'score') return 'assess';
  if (area === 'ledger' && action === 'add') return 'apply';
  if (area === 'ledger' && action === 'outcome') return 'outcome';
  if (area === 'ledger' && action === 'review') return 'review';
  if (area === 'ledger' && action === 'review-ack') return 'review';
  if (area === 'ledger' && (action === 'delivery' || action === 'retry' || action === 'deliveries')) return 'delivery';
  if (area === 'ledger' && action === 'check') return 'check';
  if (area === 'ledger') return 'other';
  if (area === 'telemetry') return 'telemetry';
  if (area === 'autonomy') return 'profile';
  if (area === 'round') return 'round';
  if (area === 'sources') return 'search';
  if (area === 'attention') return 'attention';
  if (area === 'friction') return 'friction';
  if (area === 'cloud') return 'other';
  if (area === 'review') return 'batch';
  return 'other';
}

function telemetryStage(command, error) {
  if (isAssessmentGuardStop(error)) return 'assessment';
  const message = String(error?.message ?? '');
  if (/^Usage:/i.test(message)) return 'application';
  if (/cloud|lease|intent/i.test(message)) return 'application';
  return ({
    search: 'discovery',
    assess: 'assessment',
    apply: 'submission',
    check: 'submission',
    delivery: 'outcome',
    outcome: 'outcome',
    review: 'review',
    resume: 'resume',
    profile: 'contact',
    onboard: 'contact',
    attention: 'application',
    friction: 'application',
    batch: 'application',
    other: 'application',
  })[command] ?? 'application';
}

export function telemetryErrorCategory(error) {
  if (typeof error?.telemetryErrorCategory === 'string') return error.telemetryErrorCategory;
  const message = String(error?.message ?? '');
  if (/^Usage:/i.test(message)) return 'usage';
  if (/keychain|keyring|secret service|secret-tool|credential manager|dpapi|authentication|login|lease/i.test(message)) return 'auth';
  // Resume/PDF upload before generic http/network (export errors often include "HTTP").
  if (/upload|resume|pdf/i.test(message)) return 'upload';
  if (/network|fetch|http|relay|unavailable/i.test(message)) return 'network';
  if (/profile|migration|missing or unreadable/i.test(message)) return 'profile';
  if (/cloud|intent/i.test(message)) return 'cloud';
  if (/duplicate|ledger|submission|submitted|approval|telemetry\./i.test(message)) return 'submission';
  if (/invalid|must|required|expected|unsupported/i.test(message)) return 'validation';
  return 'other';
}

export function telemetryErrorCode(error) {
  if (typeof error?.telemetryErrorCode === 'string') return error.telemetryErrorCode;
  const message = String(error?.message ?? '');
  if (/^Usage:/i.test(message)) return 'invalid_input';
  if (/keychain|keyring|secret service|secret-tool|credential manager|dpapi|authentication|login/i.test(message)) return 'authentication_required';
  if (/No local cloud lease|lease is recorded|live lease/i.test(message)) return 'authentication_required';
  // Resume/PDF upload failures before generic network/http matching (messages often include "HTTP").
  if (/upload failed|Resume export failed|did not contain a valid PDF|Canonical resume/i.test(message)) return 'upload_failed';
  if (/Cloud state (unavailable|request failed)|network|fetch|http|relay unavailable|upstream/i.test(message)) return 'network_failure';
  if (/rate.?limit/i.test(message)) return 'rate_limited';
  if (/missing or unreadable|needs migration|Expected one JSON|Unknown |is invalid|must be|requires |required|expected|unsupported|Hard duplicate|cooldown|follow-up|Usage:/i.test(message)) return 'invalid_input';
  if (/invalid|must|required|expected|unsupported/i.test(message)) return 'invalid_input';
  return 'internal_error';
}

export function telemetryErrorFieldLabel(error) {
  const message = String(error?.message ?? '');
  const match = message.match(/\b((?:entry|profile|job|attention|friction|outcome|coverage|round|candidate)\.[A-Za-z0-9_.]+)\b/);
  return sanitizeTelemetryFieldLabel(match?.[1]);
}

// Local home directory and OS username, removed from error text before it can reach analytics.
export function localIdentityForRedaction() {
  let userName;
  try { userName = userInfo().username; } catch { userName = process.env.USER || process.env.USERNAME; }
  let homeDir;
  try { homeDir = homedir(); } catch { homeDir = process.env.HOME || process.env.USERPROFILE; }
  return { homeDir, userName };
}

export function skillErrorProperties(error, command) {
  const properties = {
    errorCode: telemetryErrorCode(error),
    stage: telemetryStage(command, error),
    recoverable: true,
    errorCategory: telemetryErrorCategory(error),
  };
  const sanitizedMessage = sanitizeTelemetryErrorMessage(error?.message, localIdentityForRedaction());
  if (sanitizedMessage) properties.sanitizedMessage = sanitizedMessage;
  const fieldLabel = telemetryErrorFieldLabel(error);
  if (fieldLabel) properties.fieldLabel = fieldLabel;
  return properties;
}

function sourceToAts(source) {
  const normalized = String(source ?? '').toLowerCase();
  if (normalized === 'profile_one_click') return 'other';
  return SOURCES.has(normalized) ? normalized : 'other';
}

function shareableApplicationChannel(channel) {
  const normalized = String(channel ?? '').toLowerCase();
  if (normalized === 'profile_one_click') return 'other';
  return normalized;
}

function assessmentTags(result) {
  const matches = [];
  const gaps = [];
  for (const reason of result.reasons ?? []) {
    if (/^Role family:/i.test(reason)) matches.push('role_family');
    else if (/^Seniority:/i.test(reason)) matches.push('seniority');
    else if (/^Skills:/i.test(reason)) matches.push('skills');
    else if (/^Industry:/i.test(reason)) matches.push('industry');
    else if (/Remote-compatible/i.test(reason)) matches.push('remote');
    else if (/Target location:/i.test(reason)) matches.push('location');
  }
  for (const gap of result.gaps ?? []) {
    if (/role family/i.test(gap)) gaps.push('role_family');
    else if (/seniority/i.test(gap)) gaps.push('seniority');
    else if (/skill/i.test(gap)) gaps.push('skills');
    else if (/location|work mode/i.test(gap)) gaps.push('location');
    else if (/eligibility|authorization/i.test(gap)) gaps.push('authorization_unclear');
    else gaps.push('other');
  }
  return { matchTags: [...new Set(matches)], gapTags: [...new Set(gaps)] };
}

export async function telemetryJobAssessed(job, result) {
  if (!job.url) return null;
  const identity = await jobIdentity(job.url);
  return {
    event: 'job_assessed',
    properties: {
      ...identity,
      company: job.company,
      title: job.title,
      ats: sourceToAts(String(job.applicationChannel ?? job.source).toLowerCase()),
      fitScore: result.score,
      eligibility: String(job.eligibility).toLowerCase(),
      decision: result.decision,
      ...assessmentTags(result),
    },
  };
}

const RESUME_ANSWER_KEY = /resume|attachment|cv|curriculum/i;
export const THIN_SUBMISSION_OVERRIDE = 'THIN SUBMISSION ACKNOWLEDGED';
export const PROFILE_ONE_CLICK_CHANNEL = 'profile_one_click';

const ATTENTION_BLOCKER_ALIASES = Object.freeze({
  login: 'authentication',
  'log-in': 'authentication',
  'sign-in': 'authentication',
  signin: 'authentication',
  sso: 'authentication',
});

const ATTENTION_ACTION_ALIASES = Object.freeze({
  login: 'sign-in',
  'log-in': 'sign-in',
  'complete-login': 'sign-in',
  'upload-resume': 'enable-upload',
  'resume-upload': 'enable-upload',
});

function submissionApprovalMode(entry) {
  if (entry?.approval === 'STANDING AUTHORIZATION') return 'routine-auto';
  if (entry?.approval === 'APPROVE SUBMIT') return 'review-each';
  return null;
}

function isUnattendedOrRoutineAuto(entry, options = {}) {
  if (options.unattended === true) return true;
  if (options.approvalMode === 'routine-auto' || options.submissionMode === 'routine-auto') return true;
  return submissionApprovalMode(entry) === 'routine-auto';
}

function applicationChannelOf(entry) {
  return String(entry?.applicationChannel ?? entry?.source ?? '').toLowerCase();
}

/**
 * Normalize thinSubmissionOverride. Requires an object with the ack phrase and a
 * short per-job candidate confirmation note from the conversation — never a bare string.
 */
export function normalizeThinSubmissionOverride(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    throw new Error(
      'thinSubmissionOverride must be an object with acknowledgment and candidateConfirmation. '
      + 'A bare ack string is rejected so agents cannot auto-ack empty applies. '
      + 'Use only after an explicit, per-job candidate confirmation in the conversation — never in routine-auto or unattended runs.',
    );
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('thinSubmissionOverride must be an object with acknowledgment and candidateConfirmation.');
  }
  const acknowledgment = raw.acknowledgment ?? raw.ack ?? raw.phrase;
  const candidateConfirmation = raw.candidateConfirmation ?? raw.confirmationNote ?? raw.note;
  if (acknowledgment !== THIN_SUBMISSION_OVERRIDE) {
    throw new Error(`thinSubmissionOverride.acknowledgment must be exactly "${THIN_SUBMISSION_OVERRIDE}".`);
  }
  if (typeof candidateConfirmation !== 'string') {
    throw new Error('thinSubmissionOverride.candidateConfirmation must be a short per-job candidate confirmation note.');
  }
  const note = candidateConfirmation.trim();
  if (note.length < THIN_OVERRIDE_CONFIRMATION_MIN || note.length > THIN_OVERRIDE_CONFIRMATION_MAX) {
    throw new Error(
      `thinSubmissionOverride.candidateConfirmation must be ${THIN_OVERRIDE_CONFIRMATION_MIN}–${THIN_OVERRIDE_CONFIRMATION_MAX} characters after trim.`,
    );
  }
  if (note === THIN_SUBMISSION_OVERRIDE) {
    throw new Error('thinSubmissionOverride.candidateConfirmation must describe the candidate confirmation, not repeat the ack phrase.');
  }
  return { acknowledgment: THIN_SUBMISSION_OVERRIDE, candidateConfirmation: note };
}

function thinOverrideConfirmationDigest(note) {
  return createHash('sha256').update(String(note)).digest('hex');
}

/**
 * Reject reuse of the same confirmation note across different jobs in a batch.
 * Same job URL may retry; different URLs with the same note are blocked.
 */
export async function assertAndRecordThinOverrideUse(candidateConfirmation, jobUrl) {
  const note = String(candidateConfirmation ?? '').trim();
  const digest = thinOverrideConfirmationDigest(note);
  const url = normalizeUrl(jobUrl);
  return withStateLock(THIN_OVERRIDE_USES_STREAM, async (dir) => {
    const file = join(dir, `${THIN_OVERRIDE_USES_STREAM}.ndjson`);
    const prior = await jsonLines(file);
    for (const row of prior) {
      if (row?.confirmationDigest === digest && row?.url && row.url !== url) {
        throw new Error(
          'thinSubmissionOverride.candidateConfirmation was already used for a different job in this batch. '
          + 'Each empty-apply override needs its own explicit, per-job candidate confirmation — do not reuse one note across jobs.',
        );
      }
    }
    const event = {
      confirmationDigest: digest,
      url,
      usedAt: new Date().toISOString(),
    };
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return event;
  });
}

/**
 * A submitted entry whose fill metrics fell back to answer keys (no fill telemetry) was logged after
 * the fact, not filled by the agent. Returns 'logged' for that case and null otherwise.
 */
export function entryOriginForFillMetrics(fillMetricsSource) {
  return fillMetricsSource === 'answer_keys' ? LOGGED_ENTRY_ORIGIN : null;
}

/** True when a submission (ledger row, fill metrics, or application_submitted properties) was logged, not agent-filled. */
export function isLoggedNotAgentFilled(record) {
  return record?.entryOrigin === LOGGED_ENTRY_ORIGIN;
}

/**
 * Resolve fill metrics for application_submitted without putting answer values in telemetry.
 * Prefer explicit entry.telemetry counts; fall back to answer *keys* only (labels, not content).
 */
export function resolveSubmissionFillMetrics(entry, details = {}) {
  const answers = Object.keys(entry?.answers ?? {});
  const hasExplicitFields = details.fieldsFilled != null;
  const hasExplicitResume = details.resumeUploaded != null;
  const hasExplicitShort = details.shortAnswerCount != null;
  const resumeFromAnswers = answers.some((key) => RESUME_ANSWER_KEY.test(key));
  const fieldsFilled = hasExplicitFields ? details.fieldsFilled : answers.length;
  const resumeUploaded = hasExplicitResume ? details.resumeUploaded : resumeFromAnswers;
  const shortAnswerCount = hasExplicitShort
    ? details.shortAnswerCount
    : hasExplicitFields
      ? Math.max(0, fieldsFilled - (resumeUploaded ? 1 : 0))
      : answers.filter((key) => !RESUME_ANSWER_KEY.test(key)).length;
  const fillMetricsSource = (hasExplicitFields || hasExplicitResume || details.profileResumeOnFile === true)
    ? 'telemetry'
    : (answers.length > 0 ? 'answer_keys' : 'empty');
  // Boolean only: did the form have a résumé/CV upload field? null = unknown (left out of analytics).
  const resumeFieldPresent = typeof details.resumeFieldPresent === 'boolean' ? details.resumeFieldPresent : null;
  const entryOrigin = entryOriginForFillMetrics(fillMetricsSource);
  return {
    ...(details.durationBucket ? { durationBucket: details.durationBucket } : {}),
    fieldsFilled,
    shortAnswerCount,
    resumeUploaded: Boolean(resumeUploaded),
    fillMetricsSource,
    ...(details.profileResumeOnFile === true ? { profileResumeOnFile: true } : {}),
    ...(resumeFieldPresent != null ? { resumeFieldPresent } : {}),
    ...(entryOrigin ? { entryOrigin } : {}),
  };
}

export const JOB_APPROVAL_REVIEW_EACH = 'review-each';

/**
 * Transient per-job approval mode for one `ledger add`. Only "review-each" is accepted; it never
 * changes the stored profile's global submissionMode.
 */
export function normalizeJobApprovalMode(raw) {
  if (raw == null) return null;
  if (raw !== JOB_APPROVAL_REVIEW_EACH) {
    throw new Error(`jobApprovalMode must be "${JOB_APPROVAL_REVIEW_EACH}" when set. It applies to this one ledger add only and never changes the profile's submissionMode.`);
  }
  return JOB_APPROVAL_REVIEW_EACH;
}

/** Same thresholds as assertSubmissionFillGuard: 0 fields and no résumé, outside the honest one-click path. */
export function isThinSubmission(entry, metrics) {
  if (isFixtureOrSandboxApply(entry)) return false;
  // Logged after the fact (no fill telemetry): not an agent fill, so never an agent thin submit.
  if (isLoggedNotAgentFilled(metrics)) return false;
  if (metrics.fillMetricsSource === 'empty') return false;
  if (!(metrics.fieldsFilled === 0 && metrics.resumeUploaded !== true)) return false;
  return !(applicationChannelOf(entry) === PROFILE_ONE_CLICK_CHANNEL && metrics.profileResumeOnFile === true);
}

export function routineAutoProfileThinSubmitError() {
  return new Error(
    'Submission looks empty (0 fields filled, no résumé) and your profile submissionMode is "routine-auto", '
    + 'so this ledger add is blocked even with approval "APPROVE SUBMIT" or a per-job note. '
    + 'Preferred: fill the form and upload the canonical résumé, or, when the site applied from a stored profile/résumé, '
    + `use applicationChannel "${PROFILE_ONE_CLICK_CHANNEL}" with telemetry.profileResumeOnFile: true. `
    + 'To review this ONE job instead, first get the candidate\'s explicit confirmation for this specific job in the conversation, '
    + `then re-run ledger add with "jobApprovalMode": "${JOB_APPROVAL_REVIEW_EACH}", "approval": "APPROVE SUBMIT", and `
    + `"thinSubmissionOverride": {"acknowledgment": "${THIN_SUBMISSION_OVERRIDE}", "candidateConfirmation": "<that candidate's confirmation for this job>"}. `
    + 'jobApprovalMode applies to this entry only; it does not change your global submissionMode, which stays "routine-auto". '
    + 'Do not run profile set to change it.',
  );
}

/**
 * Block ledger add when fill metrics are missing or the submission looks empty.
 * Fixture / vendor-sandbox applies are exempt.
 * Honest one-click path: applicationChannel profile_one_click + telemetry.profileResumeOnFile.
 * Intentional empty ATS accepts need thinSubmissionOverride with a per-job candidate confirmation
 * and APPROVE SUBMIT — never routine-auto / unattended / STANDING AUTHORIZATION.
 * options.profileSubmissionMode is the stored profile's submissionMode; when it is routine-auto a thin
 * submit also needs options.jobApprovalMode "review-each" for that one entry.
 */
export function assertSubmissionFillGuard(entry, metrics, thinOverride = null, options = {}) {
  if (isFixtureOrSandboxApply(entry)) {
    return { path: 'fixture', thinSubmissionOverrideUsed: false };
  }
  if (metrics.fillMetricsSource === 'empty') {
    throw new Error(
      'entry.telemetry.fieldsFilled and entry.telemetry.resumeUploaded are required when answers are empty. '
      + 'Pass integer field counts and a Boolean resumeUploaded only — never field values, paths, or answer text in telemetry.',
    );
  }
  if (!(metrics.fieldsFilled === 0 && metrics.resumeUploaded !== true)) {
    return { path: 'filled', thinSubmissionOverrideUsed: false };
  }

  const channel = applicationChannelOf(entry);
  if (channel === PROFILE_ONE_CLICK_CHANNEL && metrics.profileResumeOnFile === true) {
    return { path: 'profile_one_click', thinSubmissionOverrideUsed: false };
  }

  // A routine-auto profile blocks thin submits even when the entry claims per-job approval,
  // unless this one job explicitly switches to review-each (the normal acknowledgement below still applies).
  const jobApprovalMode = normalizeJobApprovalMode(options.jobApprovalMode);
  if (options.profileSubmissionMode === 'routine-auto' && jobApprovalMode !== JOB_APPROVAL_REVIEW_EACH) {
    throw routineAutoProfileThinSubmitError();
  }

  let normalized;
  try {
    normalized = normalizeThinSubmissionOverride(thinOverride);
  } catch (error) {
    if (thinOverride == null) {
      throw new Error(
        'Submission looks empty (0 fields filled, no résumé). Fill the form and upload the canonical résumé before ledger add. '
        + `For one-click applies that use a stored site profile/résumé, set applicationChannel to "${PROFILE_ONE_CLICK_CHANNEL}" `
        + 'with telemetry.profileResumeOnFile: true. '
        + `A thinSubmissionOverride is only for an explicit, per-job candidate confirmation in the conversation `
        + `(object with acknowledgment "${THIN_SUBMISSION_OVERRIDE}" and candidateConfirmation) — never in routine-auto or unattended runs.`,
      );
    }
    throw error;
  }
  if (normalized == null) {
    throw new Error(
      'Submission looks empty (0 fields filled, no résumé). Fill the form and upload the canonical résumé before ledger add. '
      + `For one-click applies that use a stored site profile/résumé, set applicationChannel to "${PROFILE_ONE_CLICK_CHANNEL}" `
      + 'with telemetry.profileResumeOnFile: true. '
      + `A thinSubmissionOverride is only for an explicit, per-job candidate confirmation in the conversation `
      + `(object with acknowledgment "${THIN_SUBMISSION_OVERRIDE}" and candidateConfirmation) — never in routine-auto or unattended runs.`,
    );
  }

  if (isUnattendedOrRoutineAuto(entry, options)) {
    throw new Error(
      'thinSubmissionOverride is not allowed in routine-auto or unattended runs '
      + '(including approval STANDING AUTHORIZATION). Pause for an explicit, per-job candidate confirmation in the conversation, '
      + `or use applicationChannel "${PROFILE_ONE_CLICK_CHANNEL}" with telemetry.profileResumeOnFile: true when the site applied from a stored profile.`,
    );
  }
  if (entry.approval !== 'APPROVE SUBMIT') {
    throw new Error(
      'thinSubmissionOverride requires approval "APPROVE SUBMIT" after an explicit, per-job candidate confirmation in the conversation.',
    );
  }

  return {
    path: 'thin_override',
    thinSubmissionOverrideUsed: true,
    candidateConfirmation: normalized.candidateConfirmation,
  };
}

export function warnAnswerKeyFillMetricsFallback(fillMetricsSource) {
  if (fillMetricsSource !== 'answer_keys') return;
  process.stderr.write(
    'WARNING: ledger add used answer-key fallback fill metrics '
    + '(fillMetricsSource=answer_keys, telemetrySupplied=false). '
    + 'Resend entry.telemetry with fieldsFilled, resumeUploaded, and startedAt/endedAt or durationMs '
    + 'so analytics duration and counts are accurate — do not omit the telemetry block. '
    + 'Without it this entry is recorded as logged after the fact (entryOrigin=logged), not as an agent-filled submission. '
    + 'That is expected only when you did not fill this application in this session; never invent or reuse telemetry for it.\n',
  );
}

// Local review-only check for rapid-fire ledger adds that reuse one fill-telemetry block.
// It never blocks, drops or changes a ledger add and never changes what telemetry sends: it
// only keeps a private local stream (never synced to cloud state or any relay) and flags
// matches for the agent/candidate to review.
const FILL_TELEMETRY_REVIEW_STREAM = 'fill-telemetry-review';
export const FILL_TELEMETRY_REVIEW_WINDOW_MS = 120_000;
export const FILL_TELEMETRY_REVIEW_REASON = 'identical-fill-telemetry-rapid-fire';

/**
 * Digest of the fill-telemetry block exactly as supplied (allowed keys only), or null when no
 * fill telemetry was supplied. Two different live fills essentially never report byte-identical
 * blocks, so the same digest a few seconds apart means one block was reused.
 */
export function fillTelemetryFingerprint(rawTelemetry) {
  if (rawTelemetry == null || typeof rawTelemetry !== 'object' || Array.isArray(rawTelemetry)) return null;
  const kept = Object.fromEntries(Object.entries(rawTelemetry)
    .filter(([key, value]) => SUBMISSION_TELEMETRY_ALLOWED.has(key) && value != null));
  if (!Object.keys(kept).length) return null;
  return createHash('sha256').update(stableJson(kept)).digest('hex');
}

/**
 * Pure decision: prior rows (from the local stream) that carry the same fingerprint and were
 * recorded within the window before nowMs. Returns the matching application ids (may be empty).
 */
export function rapidFireFillTelemetryMatches(priorRows, { fingerprint, applicationId, nowMs, windowMs = FILL_TELEMETRY_REVIEW_WINDOW_MS }) {
  if (!fingerprint) return [];
  const ids = [];
  for (const row of priorRows ?? []) {
    if (row?.fingerprint !== fingerprint || !row.applicationId || row.applicationId === applicationId) continue;
    const at = Date.parse(row.recordedAt);
    if (!Number.isFinite(at) || nowMs - at > windowMs || at - nowMs > windowMs) continue;
    if (!ids.includes(row.applicationId)) ids.push(row.applicationId);
  }
  return ids;
}

/**
 * After a successful live `ledger add` with fill telemetry: record its fingerprint locally and
 * return a review flag when another add in the window reused the identical block. Best-effort:
 * any error is swallowed so the check can never break or alter a ledger add.
 */
export async function reviewRapidFireFillTelemetry(entry, rawTelemetry, { now = new Date() } = {}) {
  try {
    if (isFixtureOrSandboxApply(entry)) return null;
    const fingerprint = fillTelemetryFingerprint(rawTelemetry);
    if (!fingerprint) return null;
    return await withStateLock(FILL_TELEMETRY_REVIEW_STREAM, async (dir) => {
      const file = join(dir, `${FILL_TELEMETRY_REVIEW_STREAM}.ndjson`);
      const prior = await jsonLines(file).catch(() => []);
      const nowMs = now.getTime();
      const matchingApplicationIds = rapidFireFillTelemetryMatches(prior, { fingerprint, applicationId: entry.id, nowMs });
      const recordedAt = now.toISOString();
      const flagged = matchingApplicationIds.length > 0;
      const row = {
        applicationId: entry.id,
        recordedAt,
        fingerprint,
        ...(flagged ? { reviewFlag: FILL_TELEMETRY_REVIEW_REASON, matchingApplicationIds } : {}),
      };
      await appendFile(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
      await chmod(file, 0o600);
      if (!flagged) return null;
      const message = `Flagged for review (not blocked): ledger add for ${entry.id} carried the same fill telemetry as `
        + `${matchingApplicationIds.join(', ')} within ${FILL_TELEMETRY_REVIEW_WINDOW_MS / 1000}s. `
        + 'Each live submit must report its own telemetry from its own fill (fieldsFilled, resumeUploaded, resumeFieldPresent, timing). '
        + 'Never copy one submit\'s telemetry block to another. For entries logged after the fact, omit the telemetry block so they are recorded as entryOrigin=logged.';
      process.stderr.write(`WARNING: ${message}\n`);
      return { flagged: true, reason: FILL_TELEMETRY_REVIEW_REASON, windowSeconds: FILL_TELEMETRY_REVIEW_WINDOW_MS / 1000, matchingApplicationIds, recordedAt, message };
    });
  } catch {
    return null;
  }
}

/** Local review flags recorded by reviewRapidFireFillTelemetry (empty when none or unreadable). */
async function fillTelemetryReviewFlags(dir) {
  const rows = await jsonLines(join(dir, `${FILL_TELEMETRY_REVIEW_STREAM}.ndjson`)).catch(() => []);
  return rows.filter((row) => row?.reviewFlag === FILL_TELEMETRY_REVIEW_REASON).map((row) => ({
    applicationId: row.applicationId,
    flaggedAt: row.recordedAt,
    reason: row.reviewFlag,
    matchingApplicationIds: Array.isArray(row.matchingApplicationIds) ? row.matchingApplicationIds : [],
  }));
}

/**
 * Build application_submitted analytics. Missing telemetry must not look like an empty form:
 * send null fill counts + durationBucket "unknown" with telemetrySupplied:false.
 */
export async function telemetryApplicationSubmitted(entry, details = {}) {
  const identity = await jobIdentity(entry.url);
  const metrics = resolveSubmissionFillMetrics(entry, details);
  const fillMetricsSource = details.fillMetricsSource ?? metrics.fillMetricsSource;
  const telemetrySupplied = details.telemetrySupplied === true;
  const omitCounts = fillMetricsSource === 'empty';
  const entryOrigin = details.entryOrigin ?? entry.entryOrigin ?? entryOriginForFillMetrics(fillMetricsSource);

  let resolvedDuration = metrics.durationBucket ?? details.durationBucket ?? null;
  if (resolvedDuration == null) {
    const startedAt = details.lifecycleStartedAt ?? details.startedAt ?? null;
    const startedMs = startedAt ? Date.parse(startedAt) : Number.NaN;
    if (Number.isFinite(startedMs)) {
      const endedMs = details.endedAt ? Date.parse(details.endedAt) : Date.now();
      if (Number.isFinite(endedMs)) resolvedDuration = durationBucket(Math.max(0, endedMs - startedMs));
    }
  }
  if (resolvedDuration == null || !TELEMETRY_DURATIONS.has(resolvedDuration)) resolvedDuration = 'unknown';

  return {
    event: 'application_submitted',
    properties: {
      ...identity,
      company: entry.company,
      title: entry.role,
      ats: sourceToAts(entry.applicationChannel ?? entry.source),
      durationBucket: resolvedDuration,
      fieldsFilled: omitCounts ? null : metrics.fieldsFilled,
      shortAnswerCount: omitCounts ? null : metrics.shortAnswerCount,
      resumeUploaded: omitCounts ? null : Boolean(metrics.resumeUploaded),
      approvalMode: entry.approval === 'STANDING AUTHORIZATION' ? 'routine-auto' : 'review-each',
      telemetrySupplied,
      fillMetricsSource,
      // Absent means false. Only sent when true so relays that predate the key still accept
      // ordinary submissions (a strict relay rejects unknown properties outright).
      ...(details.thinSubmissionOverrideUsed === true ? { thinSubmissionOverrideUsed: true } : {}),
      // Optional Boolean: true = the form had a résumé/CV upload field, false = it had none.
      // Omitted when unknown (older CLIs / agents that do not report it).
      ...(typeof metrics.resumeFieldPresent === 'boolean' ? { resumeFieldPresent: metrics.resumeFieldPresent } : {}),
      // Optional: 'logged' when the entry was recorded after the fact without fill telemetry
      // (answer-key fallback), i.e. not agent-filled. Omitted otherwise, so ordinary agent submits
      // keep the pre-existing property set.
      ...(ENTRY_ORIGINS.has(entryOrigin) ? { entryOrigin } : {}),
    },
  };
}

function skipReasonFromAssessment(result) {
  const gaps = (result.gaps ?? []).join(' ').toLowerCase();
  if (/closed|stale/i.test(gaps)) return 'closed';
  if (/location|work mode|remote|excluded location/i.test(gaps)) return 'location';
  if (/salary/i.test(gaps)) return 'salary';
  if (/seniority/i.test(gaps)) return 'seniority';
  if (/eligib|authoriz|excluded by the candidate/i.test(gaps)) return 'ineligible';
  if (/skill|role family|experience/i.test(gaps)) return 'low-fit';
  if (result.decision === 'exclude') return 'ineligible';
  return 'candidate-choice';
}

export async function telemetryApplicationSkipped(job, result) {
  if (!job?.url) return null;
  const identity = await jobIdentity(job.url);
  return {
    event: 'application_skipped',
    properties: {
      jobHash: identity.jobHash,
      reason: skipReasonFromAssessment(result),
      fitScore: result.score,
      eligibility: String(job.eligibility ?? 'unclear').toLowerCase(),
    },
  };
}

const TELEMETRY_STAGES = new Set(['discovery', 'assessment', 'application', 'contact', 'resume', 'questions', 'legal', 'demographic', 'review', 'submission', 'confirmation', 'outcome']);
const ATTENTION_BLOCKER_TO_PAUSE_REASON = Object.freeze({
  authentication: 'login',
  mfa: 'mfa',
  captcha: 'captcha',
  'legal-attestation': 'legal',
  demographic: 'demographic',
  'government-id': 'sensitive-id',
  'ambiguous-authorization': 'eligibility',
  'ambiguous-compensation': 'compensation',
  'unverifiable-claim': 'unverifiable',
  judgment: 'candidate-judgment',
  video: 'candidate-judgment',
  upload: 'attachment',
  'site-error': 'site-error',
  other: 'other',
});

function normalizeTelemetryStage(stage) {
  const value = String(stage ?? 'application').toLowerCase();
  if (value === 'answers') return 'questions';
  if (value === 'upload') return 'resume';
  return TELEMETRY_STAGES.has(value) ? value : 'application';
}

function pauseReasonFromBlocker(blocker) {
  return ATTENTION_BLOCKER_TO_PAUSE_REASON[String(blocker ?? '').toLowerCase()] ?? 'other';
}

function approvalModeFromJob(job, details = {}) {
  if (details.approvalMode === 'routine-auto' || details.approvalMode === 'review-each') return details.approvalMode;
  if (job?.approval === 'STANDING AUTHORIZATION') return 'routine-auto';
  if (job?.submissionMode === 'routine-auto' || job?.submissionMode === 'review-each') return job.submissionMode;
  return 'review-each';
}

export async function telemetryApplicationStarted(job, details = {}) {
  if (!job?.url) return null;
  const identity = await jobIdentity(job.url);
  const requiredFieldCount = Number.isInteger(details.requiredFieldCount)
    ? details.requiredFieldCount
    : (Number.isInteger(job.requiredFieldCount) ? job.requiredFieldCount : 0);
  return {
    event: 'application_started',
    properties: {
      jobHash: identity.jobHash,
      ats: sourceToAts(String(details.ats ?? job.applicationChannel ?? job.source ?? 'other').toLowerCase()),
      approvalMode: approvalModeFromJob(job, details),
      requiredFieldCount,
      resumeRequired: details.resumeRequired === true || job.resumeRequired === true,
      coverLetterRequired: details.coverLetterRequired === true || job.coverLetterRequired === true,
      referralPresent: details.referralPresent === true || job.referralPresent === true,
    },
  };
}

export async function telemetryApplicationPaused(item, details = {}) {
  if (!item?.url) return null;
  const identity = await jobIdentity(item.url);
  return {
    event: 'application_paused',
    properties: {
      jobHash: identity.jobHash,
      ats: sourceToAts(String(details.ats ?? item.ats ?? item.applicationChannel ?? item.source ?? 'other').toLowerCase()),
      stage: normalizeTelemetryStage(details.stage ?? item.stage),
      reason: details.reason ?? pauseReasonFromBlocker(item.blocker),
    },
  };
}

function object(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be an object.`);
  return value;
}

function string(value, label, max = 5000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${label} must be a non-empty string no longer than ${max} characters.`);
  return value.trim();
}

function optionalPresentString(candidate, key, max) {
  if (!Object.hasOwn(candidate, key)) return '';
  return string(candidate[key], `candidate.${key}`, max);
}

function stringArray(value, label, required = false) {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${label} must be ${required ? 'a non-empty' : 'an'} array of strings.`);
  return value.map((item, index) => string(item, `${label}[${index}]`, 300));
}

function sourceId(value, label) {
  const id = string(value, label, 80).toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`${label} must be a kebab-case public source ID.`);
  return id;
}

function knownDiscoverySourceId(value, label) {
  const id = sourceId(value, label);
  if (!SOURCE_CATALOG_IDS.has(id) && !COMMUNITY_SOURCE_ID.test(id) && id !== COMMUNITY_FEED_SOURCE_ID) throw new Error(`${label} must match a packaged or community source ID.`);
  return id;
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  return value;
}

function compensationFloor(value) {
  const input = object(value, 'profile.compensationFloor');
  const allowed = new Set(['amount', 'currency', 'period']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown profile.compensationFloor property: ${key}.`);
  const currency = string(input.currency, 'profile.compensationFloor.currency', 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('profile.compensationFloor.currency must be a three-letter currency code.');
  if (input.period !== 'year') throw new Error('profile.compensationFloor.period must be year.');
  return { amount: integer(input.amount, 'profile.compensationFloor.amount', 0, 100_000_000), currency, period: 'year' };
}

function normalizeUrl(value) {
  const url = new URL(string(value, 'url', 2048));
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (!/^(job|jobid|jid|gh_jid|requisition|requisitionid|reqid|posting|postingid|position|positionid|vacancy|vacancyid)$/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString().replace(/\/$/, '').toLowerCase();
}

function terms(values) {
  return values.map((value) => value.toLowerCase().trim()).filter(Boolean);
}

function matchesAny(text, values) {
  return terms(values).filter((value) => text.includes(value));
}

export function validateProfile(input) {
  const profile = object(input, 'profile');
  for (const field of REQUIRED_PROFILE) {
    if (ARRAY_PROFILE_FIELDS.has(field)) stringArray(profile[field], `profile.${field}`, true);
    else if (NUMBER_PROFILE_FIELDS.has(field)) integer(profile[field], `profile.${field}`, field === 'yearsExperience' ? 0 : 0, field === 'yearsExperience' ? 80 : 100);
    else string(profile[field], `profile.${field}`, 1000);
  }
  if (!MODES.has(profile.submissionMode)) throw new Error('profile.submissionMode must be review-each or routine-auto.');
  if (profile.submissionModeChosenAt != null && !chosenAtValid(profile.submissionModeChosenAt)) throw new Error('profile.submissionModeChosenAt must be an ISO timestamp.');
  if (profile.manualReviewMinScore > profile.autoSubmitMinScore) throw new Error('profile.manualReviewMinScore must not exceed profile.autoSubmitMinScore.');
  for (const field of STRING_PROFILE_FIELDS) if (profile[field] != null) string(profile[field], `profile.${field}`, 2000);
  for (const field of ARRAY_PROFILE_FIELDS) if (profile[field] != null) stringArray(profile[field], `profile.${field}`);
  for (const field of NUMBER_PROFILE_FIELDS) if (profile[field] != null) integer(profile[field], `profile.${field}`, 0, field === 'yearsExperience' ? 80 : 100);
  const normalized = Object.fromEntries(Object.entries(profile).filter(([key]) => STRING_PROFILE_FIELDS.has(key) || ARRAY_PROFILE_FIELDS.has(key) || NUMBER_PROFILE_FIELDS.has(key) || OBJECT_PROFILE_FIELDS.has(key)));
  if (profile.compensationFloor != null) normalized.compensationFloor = compensationFloor(profile.compensationFloor);
  if (normalized.submissionMode !== 'routine-auto') delete normalized.submissionModeChosenAt;
  return normalized;
}

export function profileStatus(input) {
  const profile = object(input, 'profile');
  const missing = REQUIRED_PROFILE.filter((field) => profile[field] == null || profile[field] === '' || (Array.isArray(profile[field]) && profile[field].length === 0));
  const legacyFields = Object.keys(profile).filter((field) => LEGACY_PROFILE_FIELDS.has(field));
  let valid = false;
  let validationError = null;
  if (missing.length === 0) {
    try { validateProfile(profile); valid = true; } catch (error) { validationError = error.message; }
  }
  return { configured: valid, missing, legacyFields, ...(validationError ? { validationError } : {}), fields: Object.keys(profile).sort() };
}

export function migrateProfile(existingInput, overridesInput = {}) {
  const existing = object(existingInput, 'existing profile');
  const overrides = object(overridesInput, 'profile migration');
  const migrated = { ...DEFAULT_TARGETING, ...existing, ...overrides };
  if (migrated.targetCompensation == null && existing.salaryPreference != null) migrated.targetCompensation = existing.salaryPreference;
  for (const field of LEGACY_PROFILE_FIELDS) delete migrated[field];
  return validateProfile(migrated);
}

export function scoreJob(input, target) {
  const job = object(input, 'job');
  const profile = validateProfile(target);
  const title = string(job.title, 'job.title', 300);
  const company = string(job.company, 'job.company', 300);
  const description = string(job.description, 'job.description', 40000);
  const source = string(job.source, 'job.source', 40).toLowerCase();
  const discoverySource = job.discoverySource == null ? null : string(job.discoverySource, 'job.discoverySource', 40).toLowerCase();
  if (job.discoverySourceId != null) knownDiscoverySourceId(job.discoverySourceId, 'job.discoverySourceId');
  const applicationChannel = job.applicationChannel == null ? null : string(job.applicationChannel, 'job.applicationChannel', 40).toLowerCase();
  const eligibility = string(job.eligibility, 'job.eligibility', 40).toLowerCase();
  const postingStatus = string(job.postingStatus ?? 'unclear', 'job.postingStatus', 40).toLowerCase();
  const seniority = string(job.seniority ?? 'unspecified', 'job.seniority', 40).toLowerCase();
  const roleFamily = string(job.roleFamily ?? 'other', 'job.roleFamily', 80).toLowerCase();
  const workMode = string(job.workMode ?? (job.remote === true ? 'remote' : 'unspecified'), 'job.workMode', 40).toLowerCase();
  if (!SOURCES.has(source)) throw new Error('job.source is invalid.');
  if (discoverySource != null && !DISCOVERY_SOURCES.has(discoverySource)) throw new Error('job.discoverySource is invalid.');
  if (applicationChannel != null && !APPLICATION_CHANNELS.has(applicationChannel)) throw new Error('job.applicationChannel is invalid.');
  if (!ELIGIBILITY.has(eligibility)) throw new Error('job.eligibility must be eligible, unclear, or ineligible.');
  if (!POSTING_STATUS.has(postingStatus)) throw new Error('job.postingStatus must be active, closed, or unclear.');
  if (!JOB_SENIORITIES.has(seniority)) throw new Error('job.seniority is invalid.');
  if (!ROLE_FAMILIES.has(roleFamily)) throw new Error('job.roleFamily is invalid.');
  if (!WORK_MODES.has(workMode)) throw new Error('job.workMode is invalid.');

  const gates = [];
  const result = (decision, score, reasons, gaps, mustHaveCoverage = null, autoEligible = false) => ({ score, decision, autoEligible, mustHaveCoverage, gates, reasons, gaps });
  const excludedCompany = terms(profile.excludedCompanies ?? []).some((name) => company.toLowerCase().includes(name));
  if (eligibility === 'ineligible' || excludedCompany) {
    const gap = excludedCompany ? 'Company is excluded by the candidate.' : 'Posting is explicitly ineligible.';
    gates.push({ name: excludedCompany ? 'company' : 'eligibility', status: 'fail', reason: gap });
    return result('exclude', 0, [], [gap]);
  }
  if (eligibility === 'unclear') {
    const gap = 'Work eligibility or authorization needs candidate confirmation.';
    gates.push({ name: 'eligibility', status: 'ask', reason: gap });
    return result('ask', 0, [], [gap]);
  }
  gates.push({ name: 'eligibility', status: 'pass', reason: 'Posting is explicitly eligible.' });

  if (postingStatus === 'closed') {
    const gap = 'Posting or application channel is closed or stale.';
    gates.push({ name: 'posting-status', status: 'fail', reason: gap });
    return result('exclude', 0, [], [gap]);
  }
  if (postingStatus === 'unclear') {
    const gap = 'Posting status or application channel needs verification.';
    gates.push({ name: 'posting-status', status: 'ask', reason: gap });
    return result('ask', 0, [], [gap]);
  }
  gates.push({ name: 'posting-status', status: 'pass', reason: 'Direct application channel is active.' });

  const text = `${title}\n${description}`.toLowerCase();
  const locations = Array.isArray(job.locations) ? job.locations.join(' ').toLowerCase() : '';
  const reasons = [];
  const gaps = [];

  const excludedLocation = terms(profile.excludedLocations ?? []).some((place) => locations.includes(place));
  if (excludedLocation) {
    const gap = 'Posting is in an excluded location.';
    gates.push({ name: 'location', status: 'fail', reason: gap });
    return result('exclude', 0, reasons, [...gaps, gap]);
  }
  if (!terms(profile.workModes).includes(workMode)) {
    if (workMode === 'unspecified') {
      const gap = 'Work mode or location needs verification.';
      gates.push({ name: 'work-mode', status: 'ask', reason: gap });
      return result('ask', 0, reasons, [...gaps, gap]);
    }
    const gap = 'Posting work mode is incompatible with the candidate target.';
    gates.push({ name: 'work-mode', status: 'fail', reason: gap });
    return result('exclude', 0, reasons, [...gaps, gap]);
  }
  gates.push({ name: 'work-mode', status: 'pass', reason: `Work mode matches: ${workMode}.` });

  if (!terms(profile.seniority).includes(seniority)) {
    const gap = `Seniority is outside the candidate target: ${seniority}.`;
    gates.push({ name: 'seniority', status: 'fail', reason: gap });
    return result(seniority === 'unspecified' ? 'ask' : 'skip', 0, reasons, [...gaps, gap]);
  }
  gates.push({ name: 'seniority', status: 'pass', reason: `Seniority matches: ${seniority}.` });

  if (!Array.isArray(job.mustHaves) || job.mustHaves.length === 0) {
    const gap = 'Structured must-have evidence is missing.';
    gates.push({ name: 'must-have-evidence', status: 'ask', reason: gap });
    return result('ask', 0, reasons, [...gaps, gap]);
  }
  const mustHaves = job.mustHaves.map((item, index) => {
    const requirement = string(object(item, `job.mustHaves[${index}]`).requirement, `job.mustHaves[${index}].requirement`, 500);
    const status = string(item.status, `job.mustHaves[${index}].status`, 40).toLowerCase();
    if (!MUST_HAVE_STATUS.has(status)) throw new Error(`job.mustHaves[${index}].status is invalid.`);
    if (item.evidence != null) string(item.evidence, `job.mustHaves[${index}].evidence`, 2000);
    return { requirement, status };
  });
  if (mustHaves.some((item) => item.status === 'unclear')) {
    const gap = 'One or more must-have requirements need evidence verification.';
    gates.push({ name: 'must-have-evidence', status: 'ask', reason: gap });
    return result('ask', 0, reasons, [...gaps, gap]);
  }
  const mustHaveCoverage = Math.round(100 * mustHaves.reduce((sum, item) => sum + (item.status === 'met' ? 1 : item.status === 'partial' ? 0.5 : 0), 0) / mustHaves.length);
  if (mustHaveCoverage < profile.minMustHaveCoverage) {
    const gap = `Must-have evidence coverage is ${mustHaveCoverage}%, below ${profile.minMustHaveCoverage}%.`;
    gates.push({ name: 'must-have-evidence', status: 'fail', reason: gap });
    return result('skip', 0, reasons, [...gaps, gap], mustHaveCoverage);
  }
  gates.push({ name: 'must-have-evidence', status: 'pass', reason: `Must-have evidence coverage is ${mustHaveCoverage}%.` });

  if (profile.compensationFloor && job.salaryMaximum != null && String(job.salaryCurrency ?? '').toUpperCase() === profile.compensationFloor.currency) {
    integer(job.salaryMaximum, 'job.salaryMaximum', 0, 100_000_000);
    if (job.salaryMaximum < profile.compensationFloor.amount) {
      const gap = 'Published compensation maximum is below the configured floor.';
      gates.push({ name: 'compensation', status: 'fail', reason: gap });
      return result('skip', 0, reasons, [...gaps, gap], mustHaveCoverage);
    }
  }

  let score = 0;
  if (terms(profile.roleFamilies).includes(roleFamily)) { score += 25; reasons.push(`Role family: ${roleFamily}.`); }
  else gaps.push('Role family does not directly match the target.');
  score += 15;
  reasons.push(`Seniority: ${seniority}.`);
  score += Math.round(mustHaveCoverage * 0.4);
  reasons.push(`Skills evidence: ${mustHaveCoverage}% of must-haves.`);
  const locationMatches = matchesAny(locations, profile.targetLocations);
  if (locationMatches.length || workMode === 'remote') {
    score += 10;
    reasons.push(job.remote === true ? 'Remote-compatible.' : `Target location: ${locationMatches.join(', ')}.`);
  } else gaps.push('Location or work mode is not an explicit match.');
  const industryMatches = matchesAny(text, profile.industries ?? []);
  if (industryMatches.length) { score += 5; reasons.push(`Industry: ${industryMatches[0]}.`); }
  if (profile.compensationFloor && job.salaryMaximum != null && String(job.salaryCurrency ?? '').toUpperCase() === profile.compensationFloor.currency) {
    score += 5;
    reasons.push('Published compensation meets the configured floor.');
  } else gaps.push('Published compensation is unavailable or not directly comparable.');

  let experienceMismatch = false;
  if (job.experienceMin != null) integer(job.experienceMin, 'job.experienceMin', 0, 80);
  if (job.experienceMax != null) integer(job.experienceMax, 'job.experienceMax', 0, 80);
  if ((job.experienceMax != null && profile.yearsExperience > job.experienceMax + 2) || (job.experienceMin != null && profile.yearsExperience + 2 < job.experienceMin)) {
    experienceMismatch = true;
    score = Math.min(score, profile.autoSubmitMinScore - 1);
    gaps.push('Explicit experience range is materially misaligned.');
    gates.push({ name: 'experience', status: 'warn', reason: 'Experience mismatch requires manual review.' });
  }
  const finalScore = Math.min(score, 100);
  const decision = finalScore >= profile.manualReviewMinScore ? 'review' : 'skip';
  const autoEligible = decision === 'review' && ['senior', 'staff'].includes(seniority) && !experienceMismatch
    && finalScore >= profile.autoSubmitMinScore && mustHaveCoverage >= profile.minMustHaveCoverage;
  return result(decision, finalScore, reasons, gaps, mustHaveCoverage, autoEligible);
}

export function validateLedgerEntry(input) {
  const entry = object(input, 'entry');
  const normalized = {
    id: string(entry.id, 'entry.id', 180),
    company: string(entry.company, 'entry.company', 300),
    role: string(entry.role, 'entry.role', 300),
    url: string(entry.url, 'entry.url', 2048),
    source: string(entry.source, 'entry.source', 40).toLowerCase(),
    score: entry.score,
    status: string(entry.status, 'entry.status', 40).toLowerCase(),
    submittedAt: string(entry.submittedAt, 'entry.submittedAt', 80),
    approval: string(entry.approval, 'entry.approval', 80),
    answers: entry.answers ?? {},
  };
  if (entry.employerJobId != null) normalized.employerJobId = string(entry.employerJobId, 'entry.employerJobId', 300);
  if (entry.discoverySource != null) normalized.discoverySource = string(entry.discoverySource, 'entry.discoverySource', 40).toLowerCase();
  if (entry.discoverySourceId != null) {
    normalized.discoverySourceId = knownDiscoverySourceId(entry.discoverySourceId, 'entry.discoverySourceId');
  }
  if (entry.applicationChannel != null) normalized.applicationChannel = string(entry.applicationChannel, 'entry.applicationChannel', 40).toLowerCase();
  if (entry.roundId != null) normalized.roundId = string(entry.roundId, 'entry.roundId', 180);
  // applyKind marks fixture/vendor-sandbox applies so metrics/community treat them as non-employer.
  // Equivalent to "source=fixture" without overloading ATS channel `source`.
  const applyKind = resolveApplyKind(normalized.url, { applyKind: entry.applyKind });
  if (!APPLY_KINDS.has(applyKind)) throw new Error('entry.applyKind is invalid.');
  normalized.applyKind = applyKind;
  if (entry.fillMetricsSource != null) {
    if (!FILL_METRICS_SOURCES.has(entry.fillMetricsSource)) throw new Error('entry.fillMetricsSource is invalid.');
    normalized.fillMetricsSource = entry.fillMetricsSource;
  }
  if (entry.telemetrySupplied != null) {
    if (typeof entry.telemetrySupplied !== 'boolean') throw new Error('entry.telemetrySupplied must be a Boolean.');
    normalized.telemetrySupplied = entry.telemetrySupplied;
  }
  if (entry.entryOrigin != null) {
    if (!ENTRY_ORIGINS.has(entry.entryOrigin)) throw new Error('entry.entryOrigin is invalid.');
    normalized.entryOrigin = entry.entryOrigin;
  }
  if (!SOURCES.has(normalized.source)) throw new Error('entry.source is invalid.');
  if (normalized.discoverySource != null && !DISCOVERY_SOURCES.has(normalized.discoverySource)) throw new Error('entry.discoverySource is invalid.');
  if (normalized.applicationChannel != null && !APPLICATION_CHANNELS.has(normalized.applicationChannel)) {
    throw new Error('entry.applicationChannel is invalid.');
  }
  if (!Number.isInteger(normalized.score) || normalized.score < 0 || normalized.score > 100) throw new Error('entry.score must be an integer from 0 to 100.');
  if (normalized.status !== 'submitted') throw new Error('New ledger entries must have status submitted.');
  if (!APPROVALS.has(normalized.approval)) throw new Error('entry.approval is invalid.');
  if (Number.isNaN(Date.parse(normalized.submittedAt))) throw new Error('entry.submittedAt must be an ISO date.');
  object(normalized.answers, 'entry.answers');
  for (const [key, value] of Object.entries(normalized.answers)) {
    string(key, 'answer key', 200);
    string(value, `answer ${key}`, 5000);
  }
  return normalized;
}

export function validateLedgerCheckCandidate(input) {
  const candidate = object(input, 'candidate');
  const id = optionalPresentString(candidate, 'id', 180);
  const url = optionalPresentString(candidate, 'url', 2048);
  const employerJobId = optionalPresentString(candidate, 'employerJobId', 300);
  const company = optionalPresentString(candidate, 'company', 300);
  const role = optionalPresentString(candidate, 'role', 300);
  if (!url && !id && !(employerJobId && company) && !(company && role)) {
    throw new Error('ledger check requires at least one identifier set: url, id, employerJobId+company, or company+role.');
  }
  if (url) normalizeUrl(url);
  return {
    ...(id ? { id } : {}),
    ...(url ? { url } : {}),
    ...(employerJobId ? { employerJobId } : {}),
    ...(company ? { company } : {}),
    ...(role ? { role } : {}),
  };
}

export const RESUME_FIELD_UNKNOWN = 'unknown';

/**
 * `ledger add` with a telemetry block must say whether the form had a résumé/CV field. An explicit
 * `resumeUploaded: true` already implies it. Only the CLI requires this; the relay schema is unchanged.
 */
export function assertResumeFieldPresentReported(rawTelemetry) {
  if (rawTelemetry == null || typeof rawTelemetry !== 'object' || Array.isArray(rawTelemetry)) return;
  if (Object.hasOwn(rawTelemetry, 'resumeFieldPresent') && rawTelemetry.resumeFieldPresent != null) return;
  if (rawTelemetry.resumeUploaded === true) return;
  throw new Error('ledger add refused: entry.telemetry.resumeFieldPresent is required. Report true if this form had a résumé/CV upload or selection field (even optional or unused), '
    + 'false if it had none, or "unknown" only if you never saw the form. Check every step of multi-step and one-click flows such as LinkedIn Easy Apply. Nothing was recorded; add the key and retry.');
}

export function validateSubmissionTelemetry(input) {
  if (input == null) return {};
  const value = object(input, 'entry.telemetry');
  const dropped = [];
  for (const key of Object.keys(value)) {
    if (SUBMISSION_TELEMETRY_PII_KEYS.has(key)) {
      throw new Error(`entry.telemetry must not include PII property: ${key}.`);
    }
    if (!SUBMISSION_TELEMETRY_ALLOWED.has(key)) dropped.push(key);
  }
  if (dropped.length) {
    process.stderr.write(
      `Warning: dropped unknown entry.telemetry properties: ${dropped.join(', ')}. Valid metrics were kept.\n`,
    );
  }
  const cleaned = Object.fromEntries(Object.entries(value).filter(([key]) => SUBMISSION_TELEMETRY_ALLOWED.has(key)));
  if (cleaned.durationBucket != null && !TELEMETRY_DURATIONS.has(cleaned.durationBucket)) throw new Error('entry.telemetry.durationBucket is invalid.');
  if (cleaned.durationMs != null && (!Number.isInteger(cleaned.durationMs) || cleaned.durationMs < 0 || cleaned.durationMs > 86_400_000)) {
    throw new Error('entry.telemetry.durationMs must be an integer from 0 to 86400000.');
  }
  for (const key of ['startedAt', 'endedAt']) {
    if (cleaned[key] != null && Number.isNaN(Date.parse(cleaned[key]))) throw new Error(`entry.telemetry.${key} must be an ISO date.`);
  }
  for (const [key, max] of [['fieldsFilled', 500], ['shortAnswerCount', 100]]) {
    if (cleaned[key] != null && (!Number.isInteger(cleaned[key]) || cleaned[key] < 0 || cleaned[key] > max)) throw new Error(`entry.telemetry.${key} must be an integer from 0 to ${max}.`);
  }
  if (cleaned.resumeUploaded != null && typeof cleaned.resumeUploaded !== 'boolean') throw new Error('entry.telemetry.resumeUploaded must be a Boolean.');
  if (cleaned.otpVerified != null && typeof cleaned.otpVerified !== 'boolean') throw new Error('entry.telemetry.otpVerified must be a Boolean.');
  if (cleaned.profileResumeOnFile != null && typeof cleaned.profileResumeOnFile !== 'boolean') {
    throw new Error('entry.telemetry.profileResumeOnFile must be a Boolean.');
  }
  // "unknown" is an explicit answer for a form the agent never saw; it is never sent anywhere
  // (application_submitted leaves the key out, exactly like older CLIs).
  if (cleaned.resumeFieldPresent === RESUME_FIELD_UNKNOWN) delete cleaned.resumeFieldPresent;
  if (cleaned.resumeFieldPresent != null && typeof cleaned.resumeFieldPresent !== 'boolean') {
    throw new Error('entry.telemetry.resumeFieldPresent must be true (the form had a résumé/CV upload or selection field), false (it had none) or "unknown" (you never saw the form).');
  }
  if (cleaned.resumeFieldPresent === false && cleaned.resumeUploaded === true) {
    throw new Error('entry.telemetry.resumeFieldPresent cannot be false when resumeUploaded is true; a résumé upload means the form had a résumé/CV field.');
  }
  // An explicit résumé upload in this form implies the form had a résumé/CV field.
  if (cleaned.resumeFieldPresent == null && cleaned.resumeUploaded === true) cleaned.resumeFieldPresent = true;
  const details = Object.fromEntries(Object.entries(cleaned).filter(([, item]) => item != null));
  if (details.durationBucket == null) {
    let milliseconds = details.durationMs;
    if (milliseconds == null && details.startedAt && details.endedAt) {
      milliseconds = Math.max(0, Date.parse(details.endedAt) - Date.parse(details.startedAt));
    } else if (milliseconds == null && details.startedAt) {
      milliseconds = Math.max(0, Date.now() - Date.parse(details.startedAt));
    }
    if (Number.isInteger(milliseconds)) details.durationBucket = durationBucket(milliseconds);
  }
  delete details.durationMs;
  delete details.startedAt;
  delete details.endedAt;
  return details;
}

function normalizedText(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function comparableRoleTokens(value) {
  const normalized = normalizedText(value)
    .replace(/\bsr\b/g, 'senior')
    .replace(/\bjr\b/g, 'junior')
    .replace(/\bfull stack\b/g, 'fullstack')
    .replace(/\bfront end\b/g, 'frontend')
    .replace(/\bback end\b/g, 'backend');
  const ignored = new Set(['software', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'manager', 'director', 'founding']);
  return new Set(normalized.split(' ')
    .map((token) => token === 'developer' ? 'engineer' : token)
    .filter((token) => token && !ignored.has(token)));
}

function rolesLikelySame(left, right) {
  const leftTokens = comparableRoleTokens(left);
  const rightTokens = comparableRoleTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return normalizedText(left) === normalizedText(right);
  const shared = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return shared / Math.min(leftTokens.size, rightTokens.size) >= 0.75;
}

function latestMatchingEntry(entries, predicate) {
  const matches = entries.filter(predicate);
  if (matches.length === 0) return null;
  return [...matches]
    .filter((entry) => !Number.isNaN(Date.parse(entry.submittedAt)))
    .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt))[0]
    ?? matches.at(-1);
}

const canonicalApplicationKey = accountingApplicationKey;

function businessDaysBetween(startValue, endValue) {
  const start = new Date(startValue);
  const end = new Date(endValue);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return 0;
  let days = 0;
  for (const date = new Date(start); date < end; date.setUTCDate(date.getUTCDate() + 1)) {
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) days += 1;
  }
  return days;
}

export function buildReview(entries, outcomeEntries = [], acknowledgements = [], now = new Date(), deliveryEvents = []) {
  const submissions = entries
    .filter((entry) => !Number.isNaN(Date.parse(entry.submittedAt)))
    .filter((entry) => !isFixtureOrSandboxApply(entry));
  const delivery = deliveryProjection(submissions, deliveryEvents);
  const effectiveKeys = new Set(submissions.filter((entry, i) => delivery.applications[i].counted).map(canonicalApplicationKey));
  const explicitOutcomes = outcomeEntries.length > 0;
  const outcomes = explicitOutcomes ? outcomeEntries : entries.filter((entry) => ['interview', 'rejected', 'offer', 'withdrawn'].includes(entry.status));
  const groups = new Map();
  submissions.forEach((entry, index) => {
    const key = canonicalApplicationKey(entry, String(index));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });
  const recordedCanonical = [...groups.values()].map(group => [...group].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))[0]);
  const canonical = [...groups].filter(([key]) => effectiveKeys.has(key)).map(([,group]) => [...group].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))[0]);
  const outcomesById = new Map();
  for (const outcome of outcomes) {
    if (!outcomesById.has(outcome.id)) outcomesById.set(outcome.id, []);
    outcomesById.get(outcome.id).push(outcome);
  }
  const canonicalOutcomes = [];
  const matureCanonicalOutcomes = [];
  const canonicalInterviewDetails = [];
  for (const [groupKey, group] of groups) {
    const candidates = explicitOutcomes
      ? group.flatMap((entry) => outcomesById.get(entry.id) ?? [])
      : group.filter((entry) => ['interview', 'rejected', 'offer', 'withdrawn'].includes(entry.status));
    if (candidates.length) {
      const ordered = [...candidates].sort((a, b) => (Date.parse(b.occurredAt ?? 0) || 0) - (Date.parse(a.occurredAt ?? 0) || 0));
      const latest = ordered[0];
      const canonicalApplication = [...group].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt))[0];
      canonicalOutcomes.push(latest);
      const latestInterviewDetail = ordered.find((entry) => entry.interviewQuality);
      if (latestInterviewDetail) canonicalInterviewDetails.push({
        ...latestInterviewDetail,
        source: canonicalApplication.source,
        score: canonicalApplication.score,
      });
      if (effectiveKeys.has(groupKey) && businessDaysBetween(canonicalApplication.submittedAt, now) >= 10) matureCanonicalOutcomes.push(latest);
    }
  }
  const maturedApplications = canonical.filter((entry) => businessDaysBetween(entry.submittedAt, now) >= 10).length;
  const lastAck = acknowledgements.length ? acknowledgements[acknowledgements.length - 1] : {};
  const recordedMaturedApplicationCount = recordedCanonical.filter(entry => businessDaysBetween(entry.submittedAt, now) >= 10).length;
  const submittedSinceLastReview = Math.max(0, recordedCanonical.length - (lastAck.uniqueSubmissionCount ?? 0));
  const hygieneDue = submittedSinceLastReview >= 10;
  const outcomeDue = recordedMaturedApplicationCount - (lastAck.maturedApplicationCount ?? 0) >= 20;
  const reviewReasons = [...(hygieneDue ? ['submission-hygiene'] : []), ...(outcomeDue ? ['outcome-effectiveness'] : [])];
  const outcomeCounts = Object.fromEntries(['interview', 'rejected', 'offer', 'withdrawn'].map((status) => [status, canonicalOutcomes.filter((entry) => entry.status === status).length]));
  const matureOutcomeCounts = Object.fromEntries(['interview', 'rejected', 'offer', 'withdrawn'].map((status) => [status, matureCanonicalOutcomes.filter((entry) => entry.status === status).length]));
  const reasonCounts = {};
  for (const outcome of canonicalOutcomes) for (const reason of outcome.reasons ?? []) reasonCounts[reason.category] = (reasonCounts[reason.category] ?? 0) + 1;
  const interviewQualityCounts = Object.fromEntries([...INTERVIEW_QUALITIES].map((quality) => [quality, canonicalInterviewDetails.filter((entry) => entry.interviewQuality === quality).length]));
  const failurePointCounts = Object.fromEntries([...FAILURE_POINTS].map((point) => [point, canonicalInterviewDetails.filter((entry) => entry.failurePoint === point).length]));
  const interviewLearningSegmentCounts = new Map();
  for (const detail of canonicalInterviewDetails) {
    const score = Number(detail.score);
    const lower = Number.isFinite(score) ? Math.floor(Math.max(0, Math.min(100, score)) / 10) * 10 : null;
    const fitScoreBand = lower == null ? 'unknown' : `${lower}-${Math.min(100, lower + 9)}`;
    const segment = {
      source: detail.source ?? 'other',
      fitScoreBand,
      interviewQuality: detail.interviewQuality,
      failurePoint: detail.failurePoint ?? 'unknown',
    };
    const key = JSON.stringify(segment);
    interviewLearningSegmentCounts.set(key, (interviewLearningSegmentCounts.get(key) ?? 0) + 1);
  }
  const interviewLearningSegments = [...interviewLearningSegmentCounts.entries()]
    .map(([key, count]) => ({ ...JSON.parse(key), count }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.fitScoreBand.localeCompare(b.fitScoreBand) || a.interviewQuality.localeCompare(b.interviewQuality) || a.failurePoint.localeCompare(b.failurePoint));
  const rate = (count) => maturedApplications ? Math.round((1000 * count) / maturedApplications) / 10 : 0;
  return {
    reviewDue: reviewReasons.length > 0,
    reviewReasons,
    submittedTotal: canonical.length,
    uniqueSubmittedTotal: canonical.length,
    rawSubmissionRows: submissions.length,
    duplicateSubmissionRows: submissions.length - groups.size,
    recordedSubmissionCount: groups.size,
    effectiveSubmissionCount: canonical.length,
    failedDeliveryCount: delivery.failedDeliveryCount,
    receiptUnknownEmailCount: delivery.receiptUnknownEmailCount,
    submittedSinceLastReview,
    maturedApplications,
    recordedMaturedApplicationCount,
    outcomeCounts,
    matureOutcomeCounts,
    reasonCounts,
    interviewQualityCounts,
    failurePointCounts,
    interviewLearningSegments,
    conversionRates: Object.fromEntries(Object.entries(matureOutcomeCounts).map(([status, count]) => [status, rate(count)])),
    autoAppliedChanges: false,
    nextStep: reviewReasons.length
      ? 'Propose evidence-based targeting and answer-guidance changes for candidate approval.'
      : 'Continue recording confirmed submissions and outcomes.',
  };
}

function storedProfileRaw() {
  const { profile, reset } = normalizeSubmissionMode(storedProfileRawUnnormalized());
  if (reset) noticeSubmissionModeReset();
  return profile;
}

function storedProfileRawUnnormalized() {
  const cloudProfile = cachedCloudProfileRaw();
  if (cloudProfile) return cloudProfile;
  try { return object(JSON.parse(secretStore.readProfile()), 'profile'); } catch (error) {
    if (/missing or unreadable|could not read|could not store|Windows profile storage|not supported on this platform|secret-tool is not installed/i.test(error.message)) throw error;
    throw new Error('The stored profile is missing or unreadable. Run profile set again.');
  }
}

function storedProfile() {
  try { return validateProfile(storedProfileRaw()); } catch (error) {
    if (/Secret Service could not read|not supported on this platform|secret-tool is not installed/i.test(error.message)) throw error;
    throw new Error('The stored profile needs migration. Run profile check, then profile migrate --stdin.');
  }
}

/** Stored profile submissionMode, or null when no readable profile exists (read-only; never writes the profile). */
function storedSubmissionModeOrNull() {
  try {
    const mode = storedProfileRaw()?.submissionMode;
    return mode === 'routine-auto' || mode === 'review-each' ? mode : null;
  } catch {
    return null;
  }
}

async function ensureStateDir() {
  const dir = stateDir();
  await migrateLegacyStateDir(dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Set when the agent passed the JSON payload inline instead of piping it (see cli-args.mjs).
let inlineJsonInput;

async function jsonStdin() {
  if (inlineJsonInput !== undefined) {
    const value = inlineJsonInput;
    inlineJsonInput = undefined;
    return structuredClone(value);
  }
  try { return JSON.parse(await stdin()); } catch {
    throw new Error("Expected one JSON object on standard input. Pipe exactly one JSON object, e.g. echo '{...}' | node scripts/job-application.mjs <area> <action> --stdin.");
  }
}

async function jsonLines(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${index + 1} of ${basename(file)}.`); }
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function sourceCatalog() {
  return SOURCE_CATALOG;
}

export async function sourcesList(filtersInput = {}, communitySources = []) {
  const filters = object(filtersInput, 'source filters');
  const allowed = new Set(['regions', 'roleFamilies', 'kinds', 'requiresSession']);
  for (const key of Object.keys(filters)) if (!allowed.has(key)) throw new Error(`Unknown source filter: ${key}.`);
  const regions = filters.regions == null ? [] : terms(stringArray(filters.regions, 'source filters.regions'));
  const roleFamilies = filters.roleFamilies == null ? [] : terms(stringArray(filters.roleFamilies, 'source filters.roleFamilies'));
  const kinds = filters.kinds == null ? [] : terms(stringArray(filters.kinds, 'source filters.kinds'));
  if (filters.requiresSession != null && typeof filters.requiresSession !== 'boolean') throw new Error('source filters.requiresSession must be a Boolean.');
  const community = communitySources.map((source) => ({
    id: source.sourceId,
    communitySourceId: source.sourceId,
    name: source.name,
    kind: source.kind,
    jobsUrl: source.baseUrl,
    regions: source.regions,
    roleFamilies: source.roleFamilies,
    requiresSession: source.requiresSession,
    access: 'community',
    verification: 'direct-employer-or-ats',
    registryStatus: source.registryStatus,
    contributionCount: source.contributionCount,
  }));
  const sources = [...await sourceCatalog(), ...community].filter((source) => {
    if (regions.length && !source.regions.some((value) => regions.includes(value))) return false;
    if (roleFamilies.length && !source.roleFamilies.some((value) => roleFamilies.includes(value))) return false;
    if (kinds.length && !kinds.includes(source.kind)) return false;
    if (filters.requiresSession != null && source.requiresSession !== filters.requiresSession) return false;
    return true;
  });
  return { version: 1, count: sources.length, sources };
}

function sourceSuggestion(input) {
  const value = normalizeCommunitySource(input);
  return {
    type: 'suggested',
    id: `source-suggestion-${randomUUID()}`,
    ...value,
    createdAt: new Date().toISOString(),
  };
}

function shareableSuggestion(suggestion) {
  return Object.fromEntries(['name', 'baseUrl', 'kind', 'regions', 'roleFamilies', 'requiresSession'].map((key) => [key, suggestion[key]]));
}

async function markSourceShared(suggestionId, contribution) {
  if (!contribution.shared) return;
  await appendPrivateEvent('source-contribution-receipts', { suggestionId, sourceId: contribution.sourceId, sharedAt: new Date().toISOString() });
}

async function sourcesSuggest(input, community) {
  const suggestion = sourceSuggestion(input);
  await appendPrivateEvent('source-suggestions', suggestion);
  const contribution = await community.contribute(shareableSuggestion(suggestion));
  await markSourceShared(suggestion.id, contribution);
  return { queued: true, community: contribution, suggestion };
}

async function sourcesPending() {
  const suggestions = await jsonLines(join(await ensureStateDir(), 'source-suggestions.ndjson'));
  const receipts = await jsonLines(join(await ensureStateDir(), 'source-contribution-receipts.ndjson'));
  const shared = new Set(receipts.map((receipt) => receipt.suggestionId));
  const pending = suggestions.filter((suggestion) => !shared.has(suggestion.id));
  return { scope: 'local-unsent', count: pending.length, suggestions: pending };
}

async function communityPendingStatus() {
  return { ...await sourcesPending(), communityJobs: await communityJobsPending() };
}

export async function sourcesSync(community, limit = 10) {
  const pending = (await sourcesPending()).suggestions.slice(0, limit);
  let shared = 0;
  let attempted = 0;
  for (const suggestion of pending) {
    attempted += 1;
    const contribution = await community.contribute(shareableSuggestion(suggestion));
    await markSourceShared(suggestion.id, contribution);
    if (contribution.shared) shared += 1;
    else if (contribution.reason === 'disabled' || contribution.reason === 'unavailable') break;
  }
  return { attempted, shared, remaining: (await sourcesPending()).count };
}

function shareableLedgerJob(entry) {
  return normalizeCommunityJob({
    url: entry.url,
    company: entry.company,
    role: entry.role,
    applicationChannel: shareableApplicationChannel(entry.applicationChannel ?? entry.source),
    ...(entry.discoverySource == null ? {} : { discoverySource: entry.discoverySource }),
  });
}

async function markCommunityJobShared(applicationId, contribution) {
  if (!contribution.shared) return;
  await appendPrivateEvent('community-job-contribution-receipts', {
    applicationId,
    jobId: contribution.jobId,
    sharedAt: new Date().toISOString(),
  });
}

export async function communityJobsPending() {
  const directory = await ensureStateDir();
  const applications = await jsonLines(join(directory, 'applications.ndjson'));
  const receipts = await jsonLines(join(directory, 'community-job-contribution-receipts.ndjson'));
  const shared = new Set(receipts.map((receipt) => receipt.applicationId));
  const pending = [];
  let unshareable = 0;
  for (const entry of applications) {
    if (shared.has(entry.id)) continue;
    if (isFixtureOrSandboxApply(entry)) continue;
    try {
      pending.push({ applicationId: entry.id, job: shareableLedgerJob(entry) });
    } catch {
      unshareable += 1;
    }
  }
  return { count: pending.length, unshareable, applications: pending };
}

export async function communityJobsSync(community, { limit = 10, applicationIds = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Community job sync limit must be between 1 and 100.');
  const selected = applicationIds == null ? null : new Set(applicationIds);
  const state = await communityJobsPending();
  const pending = state.applications.filter((entry) => selected == null || selected.has(entry.applicationId)).slice(0, limit);
  let attempted = 0;
  let shared = 0;
  for (const entry of pending) {
    attempted += 1;
    const contribution = await community.contributeJob(entry.job);
    await markCommunityJobShared(entry.applicationId, contribution);
    if (contribution.shared) shared += 1;
    else if (contribution.reason === 'disabled' || contribution.reason === 'unavailable' || contribution.reason === 'grace') break;
  }
  const remaining = await communityJobsPending();
  return { attempted, shared, remaining: remaining.count, unshareable: remaining.unshareable };
}

async function syncAllCommunityData(community) {
  const sources = await sourcesSync(community);
  return {
    ...sources,
    communityJobs: await communityJobsSync(community),
  };
}

async function withStateLock(name, action) {
  const dir = await ensureStateDir();
  const lockPath = join(dir, `.${name}.lock`);
  let handle;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  if (!handle) throw new Error(`Could not acquire ${name} ledger lock.`);
  try { return await action(dir); }
  finally {
    await handle.close();
    await unlink(lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}

async function writePrivateJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function readPrivateJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`${basename(file)} is missing or unreadable.`);
  }
}

function autonomyView(value) {
  const enabled = value?.enabled === true && value?.mode === 'routine-auto';
  return {
    version: 1,
    enabled,
    mode: enabled ? 'routine-auto' : null,
    scopes: enabled ? [...AUTONOMY_SCOPES] : [],
    hardStops: [...AUTONOMY_HARD_STOPS],
    maySubmitRoutineApplications: false,
    maySendVerifiedRecruitingEmail: false,
    submissionsRequireBatchReview: true,
    mayCreateImprovementPr: enabled,
    mayMergeReleaseOrPublish: false,
    mayBypassHostPermissionPrompts: false,
    ...(value?.grantedAt ? { grantedAt: value.grantedAt } : {}),
    ...(value?.revokedAt ? { revokedAt: value.revokedAt } : {}),
  };
}

async function autonomyStatus() {
  const dir = await ensureStateDir();
  const stored = await readPrivateJson(join(dir, 'autonomy.json'), { version: 1, enabled: false });
  if (stored?.enabled === true && Array.isArray(stored.scopes) && stored.scopes.some((scope) => LEGACY_SEND_SCOPES.has(scope))) {
    const marker = join(dir, AUTONOMY_NOTICE_FILE);
    if (!existsSync(marker)) {
      process.stderr.write(LEGACY_GRANT_NOTICE);
      await writePrivateJson(marker, { version: 1, shownAt: new Date().toISOString() });
    }
  }
  return autonomyView(stored);
}

async function autonomyGrant(input) {
  const value = object(input, 'autonomy grant');
  const allowed = new Set(['mode']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown autonomy grant property: ${key}.`);
  if (value.mode !== 'routine-auto') throw new Error('autonomy grant mode must be routine-auto.');
  const grant = { version: 1, enabled: true, mode: 'routine-auto', scopes: [...AUTONOMY_SCOPES], grantedAt: new Date().toISOString() };
  if (await cloudState.configured()) await cloudState.putDocumentCurrent('autonomy', grant);
  const file = join(await ensureStateDir(), 'autonomy.json');
  await writePrivateJson(file, grant);
  return autonomyView(grant);
}

async function autonomyRevoke() {
  const file = join(await ensureStateDir(), 'autonomy.json');
  const current = await readPrivateJson(file, { version: 1, enabled: false });
  const revoked = { version: 1, enabled: false, revokedAt: new Date().toISOString(), ...(current.grantedAt ? { grantedAt: current.grantedAt } : {}) };
  if (await cloudState.configured()) await cloudState.putDocumentCurrent('autonomy', revoked);
  await writePrivateJson(file, revoked);
  return autonomyView(revoked);
}

/** An explicit routine-auto written through `profile set` / `profile migrate` is recorded as a choice. */
export function stampSubmissionModeChoice(profile, now = new Date()) {
  if (profile.submissionMode !== 'routine-auto' || chosenAtValid(profile.submissionModeChosenAt)) return profile;
  return { ...profile, submissionModeChosenAt: now.toISOString() };
}

async function storeProfile(profileInput) {
  const profile = stampSubmissionModeChoice(validateProfile(profileInput));
  if (await cloudState.configured()) {
    const dir = await ensureStateDir();
    await cloudState.putDocumentCurrent('profile', profile);
    await writePrivateJson(join(dir, 'cloud-profile-cache.json'), profile);
  } else {
    if (process.platform === 'win32') await ensureStateDir();
    secretStore.writeProfile(JSON.stringify(profile));
  }
  return profile;
}

async function profileSet(profileInput) {
  const profile = await storeProfile(profileInput);
  return { stored: true, fields: Object.keys(profile).sort() };
}

async function profileMigrate(overrides) {
  const before = storedProfileRaw();
  const profile = migrateProfile(before, overrides);
  await storeProfile(profile);
  return {
    migrated: true,
    fields: Object.keys(profile).sort(),
    addedFields: Object.keys(profile).filter((field) => !(field in before)).sort(),
    mappedLegacyFields: before.salaryPreference != null && profile.targetCompensation != null ? ['salaryPreference'] : [],
  };
}

async function importResume(source) {
  let bytes;
  let sourceLabel;
  if (/^https:\/\/docs\.google\.com\/document\/d\//i.test(source)) {
    const match = new URL(source).pathname.match(/^\/document\/d\/([A-Za-z0-9_-]+)/);
    if (!match) throw new Error('Invalid Google Docs resume URL.');
    const exportUrl = `https://docs.google.com/document/d/${match[1]}/export?format=pdf`;
    const response = await fetch(exportUrl, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Resume export failed with HTTP ${response.status}.`);
    bytes = Buffer.from(await response.arrayBuffer());
    sourceLabel = source;
  } else {
    const local = resolve(source);
    if (!local.toLowerCase().endsWith('.pdf')) throw new Error('Local resume must be a PDF.');
    bytes = await readFile(local);
    sourceLabel = local;
  }
  if (bytes.length < 1000 || !bytes.subarray(0, 4).equals(Buffer.from('%PDF'))) throw new Error('Resume source did not contain a valid PDF.');
  const dir = await ensureStateDir();
  const temporary = join(dir, `resume-${process.pid}.pdf`);
  const target = join(dir, 'resume.pdf');
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
  const metadata = { source: sourceLabel, importedAt: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  await writeFile(join(dir, 'resume.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  if (await cloudState.configured()) {
    await cloudState.putFileCurrent('resume.pdf', bytes);
    await cloudState.putFileCurrent('resume.json', Buffer.from(JSON.stringify(metadata)));
  }
  return { path: target, sha256: metadata.sha256, bytes: metadata.bytes };
}

/**
 * Owned fixtures and vendor sandboxes (by URL allowlist, never by a caller-supplied applyKind)
 * are not employer submissions, so they do not need a batch approval.
 */
function requiresBatchReview(url) {
  try { return resolveApplyKind(url) === 'live'; } catch { return true; }
}

/** Staging refreshes the cloud résumé cache; verification hashes the local copy the browser uploads. */
async function currentResumeDigest({ refresh = false } = {}) {
  const dir = await ensureStateDir();
  if (refresh) {
    try { await canonicalResumePath(); } catch { /* not imported, or the cloud is unreachable: hash what is cached */ }
  }
  return resumeDigest(join(dir, 'resume.pdf'));
}

const REVIEW_NEXT_STEP = 'Show the candidate `table` exactly as printed. Then run `review open <batchId>` and give the candidate the URL so they can read every item and approve on the page; poll `review status <batchId>` for the reviewToken. Where the candidate has no browser on this machine, show them the items with `review show <batchId>` and ask them to type the approval phrase in chat, then pass their exact words to `review approve --stdin`. Never open, read the code from, or operate the review page yourself, and never type the phrase for the candidate.';

function openBrowser(url) {
  if (process.env.JOB_APPLICATION_AGENT_NO_BROWSER === '1') return false;
  const os = platform();
  let command; let args;
  if (os === 'darwin') { command = 'open'; args = [url]; }
  else if (os === 'win32') { command = 'cmd'; args = ['/c', 'start', '""', url]; }
  else if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) { command = 'xdg-open'; args = [url]; }
  else return false;
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

async function openReviewPage(dir, batchId) {
  const batch = await loadBatch(dir, batchId);
  const view = batchView(batch);
  if (view.status !== 'pending') return { batchId, status: view.status, opened: false, message: `Review batch is ${view.status}; there is nothing to approve.` };
  const infoFile = reviewPageInfoFile(dir, batchId);
  const existing = await readPrivateJson(infoFile, null);
  let alive = false;
  if (existing?.pid) { try { process.kill(existing.pid, 0); alive = true; } catch { alive = false; } }
  let info = alive ? existing : null;
  if (!info) {
    await unlink(infoFile).catch(() => {});
    const logFd = openSync(join(dir, 'review-batches', `${batchId}.page.log`), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./review-page.mjs', import.meta.url)), dir, batchId, infoFile], { detached: true, stdio: ['ignore', 'ignore', logFd], env: process.env });
    child.unref();
    closeSync(logFd);
    for (let attempt = 0; attempt < 100 && !info; attempt += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      info = await readPrivateJson(infoFile, null);
    }
    if (!info) throw new Error('The review page did not start. Use the chat approval phrase instead (`review show`, then `review approve --stdin`).');
  }
  return {
    batchId,
    status: 'pending',
    url: info.url,
    browserOpened: alive ? false : openBrowser(info.url),
    pageClosesAfter: '30 minutes, or once the candidate decides',
    next: 'Give the candidate this URL (it only works on this machine). Do not open it in your own browser automation. Poll `review status <batchId>` until the status is approved, rejected or expired.',
  };
}

// Local-only gate evidence (see routine-gates.mjs). Never appended to cloud state or telemetry.
async function appendRoundEvidence(event) {
  return withStateLock('round-evidence', async (dir) => {
    const file = join(dir, ROUND_EVIDENCE_FILE);
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return event;
  });
}

async function roundEvidence(dir) {
  return jsonLines(join(dir, ROUND_EVIDENCE_FILE));
}

/** Can the browser upload the canonical résumé to an ATS form? Checks only; never uploads or sends anything. */
export async function resumeUploadPreflight() {
  const checkedAt = new Date().toISOString();
  const blocked = (reason) => ({ ok: false, blocker: RESUME_UPLOAD_BLOCKER, reason, checkedAt });
  let path;
  try { ({ path } = await canonicalResumePath()); } catch (error) { return blocked(error.message); }
  let handle;
  try { handle = await open(path, 'r'); } catch (error) {
    return blocked(`The canonical résumé is not readable (${error.code ?? 'read error'}). Fix its permissions or import it again with resume import.`);
  }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size === 0) return blocked('The canonical résumé file is empty. Import the résumé again with resume import.');
    const header = Buffer.alloc(5);
    await handle.read(header, 0, 5, 0);
    if (header.toString('latin1') !== '%PDF-') return blocked('The canonical résumé is not a PDF, the supported upload type. Import a PDF or Google Docs résumé again with resume import.');
    return { ok: true, type: 'pdf', checkedAt };
  } catch (error) {
    return blocked(`The canonical résumé could not be read (${error.code ?? 'read error'}). Import it again with resume import.`);
  } finally {
    await handle.close();
  }
}

function resumeBlockers(preflight) {
  if (!preflight || preflight.ok) return [];
  return [{
    blocker: RESUME_UPLOAD_BLOCKER,
    reason: preflight.reason,
    checkedAt: preflight.checkedAt,
    impact: 'ATS forms that need a résumé upload cannot be completed. Tell the candidate and fix the résumé; do not quietly narrow the round to one-click boards.',
  }];
}

async function recordCommunityFeedPull(community, result) {
  const ok = community.lastJobRead?.ok === true;
  await appendRoundEvidence({ type: 'community-feed-pull', ok, jobCount: Array.isArray(result?.jobs) ? result.jobs.length : 0, at: new Date().toISOString() });
  return ok;
}

// Latest score decision per job key (hash), kept so a routine-auto send can be checked against
// what `score` actually decided. Job key hashes, decisions, scores and times only.
async function recordAssessmentDecision(job, result) {
  // Same key as the skip record: the URL when scored with one, else company + title.
  const key = assessmentJobKey(job);
  if (!key) return;
  await withStateLock('assessment-decisions', async (dir) => {
    const file = join(dir, ASSESSMENT_DECISIONS_FILE);
    const state = await readPrivateJson(file, { version: 1, jobs: {} }).catch(() => ({ version: 1, jobs: {} }));
    const jobs = state?.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs) ? state.jobs : {};
    const record = { decision: result.decision, autoEligible: result.autoEligible === true, score: result.score, at: new Date().toISOString() };
    jobs[key] = record;
    await writePrivateJson(file, { version: 1, jobs });
  });
}

async function latestDecisionFor(dir, { url, company, role }) {
  const keys = [assessmentJobKey({ url }), assessmentJobKey({ company, title: role })].filter(Boolean);
  const decisions = await readPrivateJson(join(dir, ASSESSMENT_DECISIONS_FILE), null).catch(() => null);
  const guard = await readPrivateJson(join(dir, ASSESSMENT_GUARD_FILE), null).catch(() => null);
  return latestAssessmentDecision(keys, { decisions, guard });
}

async function isRoutineAutoSend(entry) {
  if (entry.approval === 'STANDING AUTHORIZATION') return true;
  const grant = await readPrivateJson(join(await ensureStateDir(), 'autonomy.json'), null).catch(() => null);
  if (autonomyView(grant).enabled) return true;
  return storedSubmissionModeOrNull() === 'routine-auto';
}

// Skip decisions are final. `score` records each skip/exclude (job key hash, decision, reason,
// time; no job text) in a private local file that the assessment-guard reset does not touch, and
// `review stage` and `ledger add` refuse that job. A later re-score never clears it, so changing
// the job input cannot turn a skip into a send.
const ASSESSMENT_SKIPS_FILE = 'assessment-skips.json';

async function recordAssessmentSkip(job, result) {
  const key = assessmentJobKey(job);
  if (!key) return;
  await withStateLock('assessment-skips', async (dir) => {
    const file = join(dir, ASSESSMENT_SKIPS_FILE);
    const state = await readPrivateJson(file, { version: 1, jobs: {} }).catch(() => ({ version: 1, jobs: {} }));
    const jobs = state?.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs) ? state.jobs : {};
    if (jobs[key]) return;
    jobs[key] = { decision: result.decision, reason: skipReasonFromAssessment(result), at: new Date().toISOString() };
    await writePrivateJson(file, { version: 1, jobs });
  });
}

async function recordAssessmentBlock(job) {
  const key = assessmentJobKey(job);
  if (!key) return;
  await withStateLock('assessment-skips', async (dir) => {
    const file = join(dir, ASSESSMENT_SKIPS_FILE);
    const state = await readPrivateJson(file, { version: 1, jobs: {} }).catch(() => ({ version: 1, jobs: {} }));
    const jobs = state?.jobs && typeof state.jobs === 'object' && !Array.isArray(state.jobs) ? state.jobs : {};
    if (jobs[key]) return;
    jobs[key] = { decision: 'blocked', reason: 'invalid-input-retries', at: new Date().toISOString() };
    await writePrivateJson(file, { version: 1, jobs });
  });
}

async function assertJobNotSkipped(dir, { url, company, role }) {
  const state = await readPrivateJson(join(dir, ASSESSMENT_SKIPS_FILE), null).catch(() => null);
  const jobs = state?.jobs;
  if (!jobs || typeof jobs !== 'object') return;
  // A job scored with a URL is keyed by that URL; one scored without a URL by company + title.
  const keys = [assessmentJobKey({ url }), assessmentJobKey({ company, title: role })].filter(Boolean);
  const skipped = keys.map((key) => jobs[key]).find((record) => record && typeof record === 'object');
  if (!skipped) return;
  throw new Error(`Skipped job refused: score decided "${skipped.decision}" (${skipped.reason}) for ${company || 'this job'} at ${skipped.at}. A skipped or excluded job is never staged, submitted or recorded, in any mode. Do not apply; tell the candidate.`);
}

async function reviewCommand(action, value) {
  const dir = await ensureStateDir();
  if (action === 'stage' && value === '--stdin') {
    const input = await jsonStdin();
    for (const item of Array.isArray(input?.items) ? input.items : []) {
      if (item?.type === 'application' && (item.purpose ?? 'submit') === 'submit') await assertJobNotSkipped(dir, { url: item.url, company: item.company, role: item.role });
    }
    const batch = await stageBatch(dir, input, { resume: await currentResumeDigest({ refresh: true }) });
    return { ...batchView(batch), next: REVIEW_NEXT_STEP };
  }
  if (action === 'show' && typeof value === 'string') return batchView(await loadBatch(dir, value), new Date(), { includeContent: true });
  if (action === 'open' && typeof value === 'string') return openReviewPage(dir, value);
  if (action === 'approve' && value === '--stdin') {
    const input = object(await jsonStdin(), 'review approve');
    for (const key of Object.keys(input)) if (!['batchId', 'phrase', 'exclude'].includes(key)) throw new Error(`Unknown review approve property: ${key}.`);
    const { batch, token } = await approveBatch(dir, input.batchId, { channel: 'chat-phrase', phrase: input.phrase, excludeNumbers: input.exclude });
    return batchView(batch, new Date(), { token });
  }
  if (action === 'status' && typeof value === 'string') {
    const batch = await loadBatch(dir, value);
    return batchView(batch, new Date(), { token: await batchToken(dir, batch) });
  }
  if (action === 'list' && value == null) return listBatches(dir);
  if (action === 'revoke' && typeof value === 'string') return batchView(await closeBatch(dir, value, 'revoked'));
  throw usageError(['review', action, value]);
}

async function canonicalResumePath() {
  const target = join(await ensureStateDir(), 'resume.pdf');
  if (await cloudState.configured()) {
    try { await cloudState.fetchResume(); }
    catch (error) {
      // Cached research and browser preparation remain usable during an
      // outage. Integrity, authentication, and checksum failures still stop.
      if (!/^Cloud state unavailable:/.test(error.message)) throw error;
    }
  }
  try {
    const details = await stat(target);
    if (!details.isFile()) throw new Error('Canonical resume path is not a file. Import the resume again.');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Canonical resume is not imported. Run resume import first.');
    throw error;
  }
  return { path: target };
}

function duplicateResult(entries, candidate, outcomes = [], now = new Date()) {
  const candidateCompany = normalizedText(candidate.company);
  const candidateRole = normalizedText(candidate.role);
  const candidateUrl = candidate.url ? normalizeUrl(candidate.url) : null;
  const sameCompanyRole = (entry) => candidateCompany && candidateRole
    && normalizedText(entry.company) === candidateCompany
    && rolesLikelySame(entry.role, candidate.role);
  const exactCompanyRole = (entry) => candidateCompany && candidateRole
    && normalizedText(entry.company) === candidateCompany
    && normalizedText(entry.role) === candidateRole;
  const hardId = candidate.id ? entries.find((entry) => entry.id === candidate.id) : null;
  const hardEmployerJobId = entries.find((entry) => candidate.employerJobId && entry.employerJobId
    && normalizedText(entry.company) === candidateCompany
    && entry.employerJobId.toLowerCase() === String(candidate.employerJobId).toLowerCase());
  const hardUrl = candidateUrl ? entries.find((entry) => normalizeUrl(entry.url) === candidateUrl) : null;
  const hard = hardId ?? hardEmployerJobId ?? hardUrl;
  const hardReason = hardId ? 'id' : hardEmployerJobId ? 'employer-job-id' : hardUrl ? 'url' : null;
  const exact = hard ? null : latestMatchingEntry(entries, exactCompanyRole);
  const fuzzyMatches = hard || exact ? [] : entries.filter(sameCompanyRole);
  const ambiguousCompanyRole = fuzzyMatches.length > 1;
  const possible = hard ? null : exact ?? (fuzzyMatches.length === 1 ? fuzzyMatches[0] : null);
  const match = hard ?? possible;
  const historyCompany = candidateCompany || normalizedText(hard?.company);
  const sameCompanyEntries = historyCompany
    ? entries.filter((entry) => normalizedText(entry.company) === historyCompany)
    : [];
  const companyApplications = sameCompanyEntries.slice(-20).map((entry) => ({
      id: entry.id,
      company: entry.company,
      role: entry.role,
      submittedAt: entry.submittedAt,
      ...(entry.employerJobId ? { employerJobId: entry.employerJobId } : {}),
    }));
  const latestCompanyApplication = [...sameCompanyEntries]
    .filter((entry) => !Number.isNaN(Date.parse(entry.submittedAt)))
    .sort((left, right) => Date.parse(right.submittedAt) - Date.parse(left.submittedAt))[0] ?? null;
  const daysSinceLatest = latestCompanyApplication
    ? Math.max(0, Math.floor((now.getTime() - Date.parse(latestCompanyApplication.submittedAt)) / 86_400_000))
    : null;
  const hasFollowUp = latestCompanyApplication
    ? outcomes.some((outcome) => outcome.id === latestCompanyApplication.id)
    : false;
  let companyReapplyDecision = 'fresh-company';
  if (hard) companyReapplyDecision = 'hard-duplicate';
  else if (possible || ambiguousCompanyRole) companyReapplyDecision = 'same-role-review';
  else if (latestCompanyApplication && hasFollowUp) companyReapplyDecision = 'follow-up-present';
  else if (latestCompanyApplication && daysSinceLatest < COMPANY_REAPPLY_COOLDOWN_DAYS) companyReapplyDecision = 'cooldown-active';
  else if (latestCompanyApplication) companyReapplyDecision = 'eligible-after-cooldown';
  return {
    duplicate: Boolean(hard),
    possibleDuplicate: Boolean(possible) || ambiguousCompanyRole,
    reason: hardReason ?? (possible || ambiguousCompanyRole ? 'company-role' : null),
    match: match ? { id: match.id, company: match.company, role: match.role, submittedAt: match.submittedAt, url: match.url } : null,
    sameCompany: companyApplications.length > 0,
    companyApplications,
    companyReapply: {
      eligible: companyReapplyDecision === 'eligible-after-cooldown',
      decision: companyReapplyDecision,
      cooldownDays: COMPANY_REAPPLY_COOLDOWN_DAYS,
      latestSubmittedAt: latestCompanyApplication?.submittedAt ?? null,
      daysSinceLatest,
      hasFollowUp,
    },
  };
}

async function ledgerCheck(candidate) {
  const normalized = validateLedgerCheckCandidate(candidate);
  const dir = await ensureStateDir();
  const entries = await jsonLines(join(dir, 'applications.ndjson'));
  const outcomes = await jsonLines(join(dir, 'outcomes.ndjson'));
  return duplicateResult(entries, normalized, outcomes);
}

async function ledgerAdd(entryInput, duplicateOverride, companyReapplyOverride, cloudIntent = null, review = null, { routineAuto = false } = {}) {
  const entry = validateLedgerEntry(entryInput);
  return withStateLock('applications', async (dir) => {
    const file = join(dir, 'applications.ndjson');
    const entries = await jsonLines(file);
    const outcomes = await jsonLines(join(dir, 'outcomes.ndjson'));
    await assertJobNotSkipped(dir, entry);
    if (entry.roundId) {
      const roundEvents = await jsonLines(join(dir, 'rounds.ndjson'));
      if (!roundEvents.some((event) => event.type === 'started' && event.roundId === entry.roundId)) throw new Error('entry.roundId does not identify a started round.');
      if (roundEvents.some((event) => event.type === 'completed' && event.roundId === entry.roundId)) throw new Error('entry.roundId identifies a completed round.');
    }
    const duplicate = duplicateResult(entries, entry, outcomes);
    if (duplicate.duplicate) throw new Error(`Hard duplicate blocked: matching ${duplicate.reason === 'employer-job-id' ? 'employer job ID or requisition' : duplicate.reason === 'url' ? 'canonical URL' : 'ledger ID'}.`);
    if (duplicate.possibleDuplicate && duplicateOverride !== 'NEW REQUISITION CONFIRMED') throw new Error('A possible same-company role duplicate requires NEW REQUISITION CONFIRMED.');
    if (!duplicate.possibleDuplicate && duplicate.companyReapply.decision === 'cooldown-active' && companyReapplyOverride !== COMPANY_REAPPLY_OVERRIDE) {
      throw new Error(`Company reapplication cooldown is active for ${COMPANY_REAPPLY_COOLDOWN_DAYS} full days; use ${COMPANY_REAPPLY_OVERRIDE} only with explicit candidate approval.`);
    }
    if (!duplicate.possibleDuplicate && duplicate.companyReapply.decision === 'follow-up-present' && companyReapplyOverride !== COMPANY_REAPPLY_OVERRIDE) {
      throw new Error(`Company reapplication blocked because the latest application has a recorded follow-up; use ${COMPANY_REAPPLY_OVERRIDE} only with explicit candidate approval.`);
    }
    let reviewed = null;
    if (review) {
      reviewed = await verifyReview(dir, review.credentials, {
        action: 'ledger add',
        match: applicationMatcher({ applicationId: entry.id, url: entry.url, answers: entry.answers }),
        checkResume: true,
        resumeSha256: review.resumeSha256,
      });
    }
    // A one-application batch is the candidate's approval of this job; a routine batch item also
    // needs the latest score to be review + autoEligible.
    const perJobApproval = Boolean(reviewed) && isPerJobApproval(reviewed.batch);
    if (reviewed && routineAuto && !perJobApproval) {
      const refusal = routineSubmitGateMessage(await latestDecisionFor(dir, entry), entry.company);
      if (refusal) throw new Error(refusal);
    }
    const reapproved = ['cooldown-active', 'follow-up-present'].includes(duplicate.companyReapply.decision)
      ? { ...entry, reapplicationApproval: 'candidate-explicit' }
      : entry;
    const storedEntry = reviewed
      ? { ...reapproved, reviewBatchId: reviewed.batch.batchId, reviewApprovedAt: reviewed.batch.approvedAt, reviewApprovalChannel: reviewed.batch.approvalChannel }
      : reapproved;
    await appendFile(file, `${JSON.stringify(storedEntry)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    if (entry.roundId) {
      const roundsFile = join(dir, 'rounds.ndjson');
      await appendFile(roundsFile, `${JSON.stringify({ type: 'submission-confirmed', roundId: entry.roundId, applicationId: entry.id, occurredAt: entry.submittedAt })}\n`, { mode: 0o600 });
      await chmod(roundsFile, 0o600);
    }
    if (await cloudState.configured()) {
      if (cloudIntent?.intentId && cloudIntent?.leaseId) {
        await cloudState.confirmIntent(cloudIntent.intentId, storedEntry, cloudIntent.leaseId, `application:${storedEntry.id}:${storedEntry.submittedAt}`);
      } else {
        await cloudState.appendRecord('applications', storedEntry, { recordKey: storedEntry.id, idempotencyKey: `application:${storedEntry.id}:${storedEntry.submittedAt}`, occurredAt: storedEntry.submittedAt, queueOnFailure: true });
        if (entry.roundId) await cloudState.appendRecord('rounds', { type: 'submission-confirmed', roundId: entry.roundId, applicationId: entry.id, occurredAt: entry.submittedAt }, { recordKey: entry.roundId, idempotencyKey: `round-confirmation:${entry.roundId}:${entry.id}`, occurredAt: entry.submittedAt, queueOnFailure: true });
      }
    }
    if (reviewed) await consumeReview(dir, reviewed.batch.batchId, reviewed.item.itemId, 'ledger-add');
    let roundCount = null;
    if (entry.roundId) {
      await appendRoundEvidence({ type: 'submit-recorded', roundId: entry.roundId, applicationId: entry.id, at: new Date().toISOString() });
      if (isLoggedNotAgentFilled(entry) && !perJobApproval && roundGatesRecord(await roundEvidence(dir), entry.roundId)) {
        roundCount = { counted: false, reason: 'entryOrigin=logged entries count toward a round target only with a per-job approval (a one-application review batch). The entry is recorded in the ledger but not counted for this round.' };
      }
    }
    return { recorded: storedEntry.id, ...(roundCount ? { roundCount } : {}), review: buildReview([...entries, storedEntry], outcomes, [], new Date(), await jsonLines(join(dir, 'delivery.ndjson'))), ...(cloudIntent ? { cloudIntent: cloudIntent.intentId } : {}) };
  });
}

async function appendCloudEvent(name, event) {
  if (!await cloudState.configured()) return;
  const key = event.id ?? event.roundId ?? event.applicationId ?? randomUUID();
  await cloudState.appendRecord(name, event, { recordKey: key, idempotencyKey: `${name}:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`, occurredAt: event.occurredAt, queueOnFailure: true });
}

async function appendPrivateEvent(name, event) {
  return withStateLock(name, async (dir) => {
    const file = join(dir, `${name}.ndjson`);
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    if (['rounds', 'discovery', 'attention', 'friction'].includes(name)) await appendCloudEvent(name, event);
    return event;
  });
}

function isoDate(value, label) {
  const result = string(value ?? new Date().toISOString(), label, 80);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} must be an ISO date.`);
  return result;
}

async function appendAccounting(stream, event, { cloudConfirmed = false } = {}) {
  const file = join(await ensureStateDir(), `${stream}.ndjson`);
  const previous = await jsonLines(file);
  const matches = previous.filter(e => e.id === event.id);
  if (matches.some(e => stableJson(e) !== stableJson(event))) throw new Error('Conflicting accounting event ID.');
  if (matches.length) return { recorded: false, duplicate: true, event };
  await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  if (!cloudConfirmed && await cloudState.configured()) await cloudState.appendRecord(stream, event, { recordKey: event.id, idempotencyKey: `accounting:${event.id}`, occurredAt: event.occurredAt ?? event.observedAt, queueOnFailure: true });
  return { recorded: true, duplicate: false, event };
}

async function recordDelivery(input, retry = false) {
  const { cloudIntentId, cloudLeaseId, reviewBatchId, reviewToken, ...raw } = object(input, 'delivery');
  const event = validateDelivery({ ...raw, ...(retry ? { type: 'retry-confirmed' } : {}) });
  if (!retry && event.type === 'retry-confirmed') throw new Error('Use ledger retry for replacement transmissions.');
  return withStateLock('applications', () => withStateLock('delivery', async dir => {
    const applications = await jsonLines(join(dir, 'applications.ndjson'));
    const events = await jsonLines(join(dir, 'delivery.ndjson'));
    const cloudRetry = retry && await cloudState.configured();
    if (cloudRetry && !events.some(e => e.id === event.id) && (!cloudIntentId || !cloudLeaseId || event.attemptId !== cloudIntentId)) throw new Error('Cloud retry requires its intent and live lease; attemptId must equal cloudIntentId.');
    // Cloud transmission eligibility was checked at intent preparation. The
    // Worker verifies that intent before we persist the observed transmission.
    validateDeliveryReferences(event, applications, events, { preparedRetry: cloudRetry });
    // A replacement transmission is a new send: it needs its own approved batch item.
    let reviewed = null;
    if (retry && !events.some(e => e.id === event.id) && requiresBatchReview(event.url)) {
      reviewed = await verifyReview(dir, { reviewBatchId, reviewToken }, {
        action: 'ledger retry',
        match: applicationMatcher({ applicationId: event.applicationId, url: event.url, purpose: 'retry' }),
        checkResume: true,
        resumeSha256: (await currentResumeDigest())?.sha256,
      });
    }
    let cloudConfirmed = false;
    if (cloudRetry && !events.some(e => e.id === event.id)) {
      await cloudState.confirmRetry(cloudIntentId, event, cloudLeaseId);
      cloudConfirmed = true;
    }
    const result = await appendAccounting('delivery', event, { cloudConfirmed });
    if (reviewed && result.recorded) await consumeReview(dir, reviewed.batch.batchId, reviewed.item.itemId, 'ledger-retry');
    return { ...result, delivery: deliveryProjection(applications, [...events, event]) };
  }));
}
async function deliveryHistory(applicationId) {
  const dir = await ensureStateDir();
  const apps = (await jsonLines(join(dir, 'applications.ndjson'))).filter(a => !applicationId || a.id === applicationId);
  const events = (await jsonLines(join(dir, 'delivery.ndjson'))).filter(e => !applicationId || e.applicationId === applicationId);
  return { ...deliveryProjection(apps, events), events };
}
async function recordLead(input) {
  const event = validateLead(input);
  knownDiscoverySourceId(event.sourceId, 'lead.sourceId');
  return withStateLock('rounds', async dir => {
    const round = await roundStatus(event.roundId);
    const events = await jsonLines(join(dir, 'discovery.ndjson'));
    if (round.completed && !event.supersedes && !events.some(e => e.id === event.id)) throw new Error('Completed rounds accept only corrections to existing leads.');
    validateLeadReferences(event, events);
    const result = await appendAccounting('discovery', event);
    if (result.recorded) await appendRoundEvidence({ type: 'lead-recorded', roundId: event.roundId, sourceId: event.sourceId, leadId: event.id, at: new Date().toISOString() });
    return result;
  });
}
async function leadHistory(roundId) {
  const dir = await ensureStateDir();
  const id = roundId ?? (await roundStatus()).roundId;
  const history = (await jsonLines(join(dir, 'discovery.ndjson'))).filter(e => e.roundId === id);
  return { ...discoveryProjection(history, { roundId: id }), history };
}

async function roundStart(input) {
  const value = object(input, 'round');
  const allowed = new Set(['requestedCount', 'startedAt']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown round property: ${key}.`);
  const event = {
    type: 'started',
    roundId: `round-${new Date().toISOString().slice(0, 10)}-${randomUUID()}`,
    discoveryPolicyVersion: 2,
    requestedCount: integer(value.requestedCount, 'round.requestedCount', 1, 1000),
    occurredAt: isoDate(value.startedAt, 'round.startedAt'),
  };
  await appendPrivateEvent('rounds', event);
  await appendRoundEvidence({ type: 'round-gates', version: ROUND_GATES_VERSION, roundId: event.roundId, at: new Date().toISOString() });
  const resumePreflight = await resumeUploadPreflight();
  await appendRoundEvidence({ type: 'resume-preflight', roundId: event.roundId, ...resumePreflight });
  const blockers = resumeBlockers(resumePreflight);
  return {
    roundId: event.roundId, requestedCount: event.requestedCount, startedAt: event.occurredAt, completed: false,
    discoveryPolicy: { minSources: MIN_DISCOVERY_SOURCES, concentrationThresholdPercent: CONCENTRATION_THRESHOLD, communityFeedPullRequired: true, coverageMustPrecedeSubmissions: true },
    resumePreflight,
    blockers,
    nextStep: `${blockers.length ? `Résumé upload is unavailable (${RESUME_UPLOAD_BLOCKER}): tell the candidate now; ATS forms that need a résumé will fail. ` : ''}Run sources jobs (the community job feed, required once per round), search at least 3 distinct relevant discovery sources, record each reviewed lead with round lead --stdin and each search or blocker with round source --stdin, and review round status before applying. Coverage recorded after the round's submissions does not count.`,
  };
}

function discoveryGroup(id) {
  // Two views of the same hiring network do not demonstrate independent coverage.
  if (['yc-work-at-a-startup', 'yc-company-directory'].includes(id)) return 'yc';
  return id;
}

function discoverySummary(events, applications, completion, audit = null) {
  const latest = new Map();
  const searchedIds = new Set();
  const attribution = new Map();
  for (const event of events.filter((item) => item.type === 'source-checked')) {
    latest.set(event.sourceId, event);
    if (event.status === 'searched') searchedIds.add(event.sourceId);
    for (const id of event.applicationIds ?? []) attribution.set(id, event.sourceId);
  }
  const sources = [...latest.values()].map(report => {
    const leads = audit?.leads.filter(lead => lead.sourceId === report.sourceId) ?? [];
    return audit ? { ...report, reviewedCount: leads.length, qualifiedCount: leads.filter(lead => !lead.conflict && lead.disposition === 'qualified').length, accounting: 'per-lead' } : { ...report, accounting: 'legacy-unverified' };
  });
  const eligible = sources.filter((item) => !['recruiter-inbound', 'user-supplied-leads'].includes(item.sourceId));
  const attempted = new Set(eligible.map((item) => discoveryGroup(item.sourceId)));
  const searched = new Set(eligible.filter((item) => searchedIds.has(item.sourceId)).map((item) => discoveryGroup(item.sourceId)));
  const distribution = new Map();
  let unattributedCount = 0;
  for (const entry of applications) {
    const source = entry.discoverySourceId ?? attribution.get(entry.id);
    if (!source || !searchedIds.has(source)) { unattributedCount++; continue; }
    const group = discoveryGroup(source);
    distribution.set(group, (distribution.get(group) ?? 0) + 1);
  }
  const maxCount = Math.max(0, ...distribution.values());
  const maxSourceSharePercent = applications.length ? Math.round(maxCount / applications.length * 100) : 0;
  return {
    minSources: MIN_DISCOVERY_SOURCES,
    attemptedSourceCount: attempted.size,
    searchedSourceCount: searched.size,
    blockedSourceCount: [...attempted].filter((id) => !searched.has(id)).length,
    coverageSatisfied: attempted.size >= MIN_DISCOVERY_SOURCES && searched.size > 0,
    sources: sources.map(({ sourceId, status, reviewedCount, qualifiedCount, blocker, evidence }) => ({ sourceId, status, searchedDuringRound: searchedIds.has(sourceId), reviewedCount, qualifiedCount, ...(blocker ? { blocker } : {}), evidence })),
    submissionDistribution: [...distribution].map(([sourceId, count]) => ({ sourceId, count })),
    unattributedCount,
    maxSourceSharePercent,
    concentrationNeedsExplanation: applications.length > 0 && maxCount / applications.length * 100 > CONCENTRATION_THRESHOLD,
    ...(completion?.concentrationReason ? { concentrationReason: completion.concentrationReason, concentrationEvidence: completion.concentrationEvidence } : {}),
  };
}

async function roundSource(input) {
  const value = object(input, 'source coverage');
  const allowed = new Set(['roundId', 'sourceId', 'status', 'reviewedCount', 'qualifiedCount', 'blocker', 'evidence', 'applicationIds']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown source coverage property: ${key}.`);
  const sourceId = knownDiscoverySourceId(value.sourceId, 'coverage.sourceId');
  const status = string(value.status, 'coverage.status', 20);
  if (!['searched', 'blocked'].includes(status)) throw new Error('coverage.status must be searched or blocked.');
  const roundId = string(value.roundId, 'coverage.roundId', 180);
  const blocker = value.blocker == null ? null : string(value.blocker, 'coverage.blocker', 40);
  if (status === 'searched' && blocker != null) throw new Error('Searched sources cannot have a blocker.');
  const evidence = string(value.evidence, 'coverage.evidence', 2000);
  const applicationIds = value.applicationIds == null ? [] : [...new Set(stringArray(value.applicationIds, 'coverage.applicationIds'))];
  if (applicationIds.length > 1000 || (status === 'blocked' && applicationIds.length)) throw new Error('Invalid coverage.applicationIds.');
  const event = await withStateLock('rounds', async (dir) => {
    const round = await roundStatus(roundId);
    if (round.completed) throw new Error('Cannot record coverage for a completed round.');
    const audit = discoveryProjection(await jsonLines(join(dir, 'discovery.ndjson')), { roundId: value.roundId });
    const leads = audit.leads.filter(lead => lead.sourceId === sourceId);
    const derivedReviewed = status === 'blocked' ? 0 : leads.length;
    const derivedQualified = status === 'blocked' ? 0 : leads.filter(lead => !lead.conflict && lead.disposition === 'qualified').length;
    const reviewedCount = round.discoveryPolicyVersion === 2 ? derivedReviewed : integer(value.reviewedCount, 'coverage.reviewedCount', 0, 10000);
    const qualifiedCount = round.discoveryPolicyVersion === 2 ? derivedQualified : integer(value.qualifiedCount, 'coverage.qualifiedCount', 0, reviewedCount);
    // Per-lead rounds derive counts from `round lead` records; passed counts are assertions that
    // must match (a stale tally is rejected). Say what is recorded and how to fix the call.
    if (round.discoveryPolicyVersion === 2 && ((value.reviewedCount != null && value.reviewedCount !== reviewedCount) || (value.qualifiedCount != null && value.qualifiedCount !== qualifiedCount))) {
      throw new Error(`Source count assertions do not match recorded leads (recorded for this source: reviewed ${reviewedCount}, qualified ${qualifiedCount}). Record every reviewed lead with round lead --stdin before round source, or omit reviewedCount/qualifiedCount so they are derived.`);
    }
    if (status === 'blocked' && (!SOURCE_BLOCKERS.has(blocker) || reviewedCount !== 0 || qualifiedCount !== 0)) throw new Error('Blocked sources require a documented blocker and zero counts.');
    const evidence = await roundEvidence(dir);
    const gates = roundGatesRecord(evidence, round.roundId);
    if (gates) {
      const pulls = feedPulls(evidence, Date.parse(gates.at));
      if (sourceId === COMMUNITY_FEED_SOURCE_ID && status === 'searched' && !pulls.some((pull) => pull.ok === true)) {
        throw new Error(`Coverage refused: ${COMMUNITY_FEED_SOURCE_ID} is marked searched, but no successful \`sources jobs\` pull was recorded in this round. Run \`sources jobs\` and review its leads first. If that call failed, record the source as blocked with blocker access-unavailable (community feed unavailable).`);
      }
      if (sourceId === COMMUNITY_FEED_SOURCE_ID && status === 'blocked' && (!pulls.some((pull) => pull.ok !== true) || !COMMUNITY_FEED_BLOCKERS.includes(blocker))) {
        throw new Error(`Coverage refused: ${COMMUNITY_FEED_SOURCE_ID} can be recorded as blocked (community feed unavailable) only after a \`sources jobs\` call in this round failed, with blocker access-unavailable or site-error. Run \`sources jobs\` first; if it returns leads, review them and record the source as searched.`);
      }
      if (sourceId !== COMMUNITY_FEED_SOURCE_ID && status === 'searched' && !['recruiter-inbound', 'user-supplied-leads'].includes(sourceId)) {
        if (!leads.length) {
          throw new Error(`Coverage refused: ${sourceId} is marked searched, but no leads were recorded for it in this round. Record every reviewed lead with round lead --stdin before round source (an empty search is one lead with disposition "no-relevant-opening" and the search URL); a source you could not search is "blocked" with its blocker.`);
        }
        // Leads recorded only after every submission so far are after-the-fact coverage.
        const lastSubmissionAt = round.routineGates?.coverage?.lastSubmissionAt;
        const earliest = leadTimesBySource(evidence, round.roundId, await jsonLines(join(dir, 'discovery.ndjson'))).get(sourceId)?.[0];
        if (lastSubmissionAt && Number.isFinite(earliest) && earliest > Date.parse(lastSubmissionAt)) {
          throw new Error(afterSubmissionCoverageMessage([sourceId], lastSubmissionAt));
        }
      }
    }
    const applications = await jsonLines(join(dir, 'applications.ndjson'));
    for (const id of applicationIds) {
      const entry = applications.find((item) => item.id === id && item.roundId === round.roundId && item.status === 'submitted');
      if (!entry || (entry.discoverySourceId && entry.discoverySourceId !== sourceId)) throw new Error('Coverage attribution must match a confirmed application in this round and its saved source.');
    }
    const event = { type: 'source-checked', roundId: round.roundId, sourceId, status, reviewedCount, qualifiedCount, evidence, applicationIds, ...(blocker ? { blocker } : {}), occurredAt: new Date().toISOString() };
    const file = join(dir, 'rounds.ndjson');
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return event;
  });
  await appendCloudEvent('rounds', event);
  return event;
}

function replayAttention(events, roundId = null) {
  const active = new Map();
  for (const event of events) {
    if (event.type === 'opened') active.set(event.id, event);
    else if (event.type === 'resolved') active.delete(event.id);
  }
  const priority = (blocker) => {
    if (['authentication', 'mfa', 'captcha'].includes(blocker)) return 0;
    if (['legal-attestation', 'ambiguous-authorization', 'ambiguous-compensation'].includes(blocker)) return 1;
    return 2;
  };
  return [...active.values()]
    .filter((item) => roundId == null || item.roundId === roundId)
    .sort((a, b) => priority(a.blocker) - priority(b.blocker) || Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

async function attentionList(roundId = null) {
  const events = await jsonLines(join(await ensureStateDir(), 'attention.ndjson'));
  const items = replayAttention(events, roundId);
  const dir = await ensureStateDir();
  const apps = await jsonLines(join(dir, 'applications.ndjson'));
  const delivery = deliveryProjection(apps, await jsonLines(join(dir, 'delivery.ndjson')));
  for (const item of delivery.applications.filter(a => a.failed || a.conflict)) {
    const app = apps.find(a => a.id === item.applicationId);
    if (roundId && app.roundId !== roundId) continue;
    items.push({ id: `delivery:${app.id}`, applicationId: app.id, roundId: app.roundId ?? null, url: app.url, stage: 'confirmation', blocker: item.conflict ? 'delivery-conflict' : 'delivery-failed', requiredActions: ['review-delivery'], derived: true });
  }
  const discovery = discoveryProjection(await jsonLines(join(dir, 'discovery.ndjson')), { roundId });
  for (const lead of discovery.leads.filter(l => l.conflict)) items.push({ id: `discovery:${lead.key}`, roundId: lead.roundId, url: lead.url, stage: 'discovery', blocker: 'assessment-conflict', requiredActions: ['review-assessment'], derived: true });
  return { count: items.length, items };
}

async function attentionNotifyHook(event, context = {}) {
  const notifyUrl = process.env.ATTENTION_NOTIFY_URL?.trim();
  const notifySecret = process.env.ATTENTION_NOTIFY_SECRET?.trim();
  if (!notifyUrl || !notifySecret) return { attempted: false, reason: 'notify_unconfigured' };

  let email = '';
  try { email = String(storedProfileRaw()?.email ?? '').trim().toLowerCase(); } catch { email = ''; }
  if (!email) {
    console.error('[attention-notify] profile email missing; skip notify fail-closed');
    return { attempted: true, ok: false, error: 'profile_email_missing' };
  }

  const company = String(context.company ?? '').trim() || 'Company';
  const role = String(context.role ?? '').trim() || 'Role';
  try {
    const response = await fetch(notifyUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${notifySecret}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        attentionId: event.id,
        email,
        company,
        role,
        url: event.url,
        stage: event.stage,
        blocker: event.blocker,
        requiredActions: event.requiredActions,
        questions: event.questions ?? [],
        aiAssistanceDiscouraged: Boolean(event.aiAssistanceDiscouraged),
        postingText: context.postingText ?? '',
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[attention-notify] site notify failed (${response.status}): ${body?.error ?? 'unknown'}`);
      return { attempted: true, ok: false, error: body?.error ?? 'notify_failed', status: response.status };
    }
    return { attempted: true, ok: true, magicLinkUrl: body?.magicLinkUrl ?? null, emailId: body?.emailId ?? null };
  } catch (error) {
    console.error(`[attention-notify] site notify request failed: ${error instanceof Error ? error.message : 'unknown'}`);
    return { attempted: true, ok: false, error: 'notify_request_failed' };
  }
}

function normalizeAttentionBlocker(value) {
  const raw = string(value, 'attention.blocker', 60).toLowerCase();
  return ATTENTION_BLOCKER_ALIASES[raw] ?? raw;
}

function normalizeAttentionActions(value) {
  const actions = stringArray(value, 'attention.requiredActions', true).map((item) => {
    const raw = item.toLowerCase();
    return ATTENTION_ACTION_ALIASES[raw] ?? raw;
  });
  return [...new Set(actions)];
}

function sessionBindingAttentionError(error) {
  const code = String(error?.message ?? error ?? '');
  if (/browserProfilePath/i.test(code)) {
    return new Error('attention.browserProfilePath is required when writing a session binding.');
  }
  if (/display/i.test(code)) {
    return new Error('attention.display must be :99 (fill session); never TigerVNC :1.');
  }
  if (/vncPort/i.test(code)) {
    return new Error('attention.vncPort must be 5900 (fill x11vnc); never 5901.');
  }
  if (/jobUrl|tabHint/i.test(code)) {
    return new Error(`attention session binding is invalid: ${code}.`);
  }
  return new Error(`attention session binding is invalid: ${code}.`);
}

async function attentionAdd(input) {
  const value = object(input, 'attention item');
  if (Object.hasOwn(value, 'answers')) {
    throw new Error(
      'Unknown attention property: answers. Candidate responses must not be stored on attention add; '
      + 'use the hosted resume signal answers[] / answer bank path instead.',
    );
  }
  const allowed = new Set([
    'roundId', 'applicationId', 'url', 'stage', 'blocker', 'requiredActions', 'createdAt', 'company', 'role', 'title',
    // P1.5 judgment packaging (prompts only — never candidate responses).
    'questions', 'postingText', 'aiAssistanceDiscouraged',
    // Local-only session binding hooks — never appended to the cloud attention event.
    ...SESSION_BINDING_ATTENTION_KEYS,
  ]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown attention property: ${key}.`);
  const stage = string(value.stage, 'attention.stage', 40).toLowerCase();
  const blocker = normalizeAttentionBlocker(value.blocker);
  if (!ATTENTION_STAGES.has(stage)) throw new Error('attention.stage is invalid.');
  if (!ATTENTION_BLOCKERS.has(blocker)) throw new Error('attention.blocker is invalid.');
  const requiredActions = normalizeAttentionActions(value.requiredActions);
  if (requiredActions.length > 8 || requiredActions.some((item) => !REQUIRED_ACTIONS.has(item))) throw new Error('attention.requiredActions must contain only documented actions.');
  const applicationId = string(value.applicationId, 'attention.applicationId', 180);
  let company = typeof value.company === 'string' ? value.company.trim() : '';
  let role = typeof value.role === 'string' ? value.role.trim() : '';
  if (!role && typeof value.title === 'string') role = value.title.trim();
  if (!company || !role) {
    try {
      const apps = await jsonLines(join(await ensureStateDir(), 'applications.ndjson'));
      const match = apps.find((entry) => entry.id === applicationId);
      if (match) {
        company = company || String(match.company ?? '').trim();
        role = role || String(match.role ?? match.title ?? '').trim();
      }
    } catch { /* best-effort context for notify only */ }
  }
  const postingText = typeof value.postingText === 'string' ? value.postingText.slice(0, 20_000) : '';
  let questions = normalizeAttentionQuestions(value.questions);
  if (!questions.length && postingText && requiredActions.includes('provide-judgment')) {
    questions = extractNarrativeQuestionsFromText(postingText);
  }
  const aiAssistanceDiscouraged = value.aiAssistanceDiscouraged === true
    || detectAiAssistanceDiscouraged(postingText);
  const localBindingFields = extractSessionBindingFields(value);
  const event = {
    type: 'opened',
    id: `attention-${randomUUID()}`,
    roundId: string(value.roundId, 'attention.roundId', 180),
    applicationId,
    url: string(value.url, 'attention.url', 2048),
    stage,
    blocker,
    requiredActions: [...new Set(requiredActions)],
    // Prompts only — never store candidate responses on the attention queue.
    ...(questions.length ? { questions } : {}),
    ...(aiAssistanceDiscouraged ? { aiAssistanceDiscouraged: true } : {}),
    createdAt: isoDate(value.createdAt, 'attention.createdAt'),
  };
  await appendPrivateEvent('attention', event);

  let sessionBinding = null;
  if (localBindingFields) {
    let binding;
    try {
      binding = createSessionBinding({
        attentionId: event.id,
        jobUrl: event.url,
        applicationId: event.applicationId,
        roundId: event.roundId,
        createdAt: event.createdAt,
        questions: event.questions,
        aiAssistanceDiscouraged: event.aiAssistanceDiscouraged,
        ...localBindingFields,
      });
    } catch (error) {
      throw sessionBindingAttentionError(error);
    }
    const path = sessionBindingPath(await ensureStateDir(), event.id);
    sessionBinding = { path, binding: await writeSessionBindingFile(path, binding) };
  }

  const notify = await attentionNotifyHook(event, { company, role, postingText });
  const base = sessionBinding ? { ...event, sessionBinding } : event;
  return notify.attempted ? { ...base, notify } : base;
}

async function attentionResolve(input) {
  const value = object(input, 'attention resolution');
  const allowed = new Set(['id', 'resolvedAt']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown attention resolution property: ${key}.`);
  const id = string(value.id, 'attention.id', 180);
  const current = await attentionList();
  if (current.items.some(item => item.id === id && item.derived)) throw new Error('Resolve accounting attention with a delivery correction, verified recovery, or lead revision.');
  if (!current.items.some((item) => item.id === id)) throw new Error('Attention item is not active.');
  const event = { type: 'resolved', id, resolvedAt: isoDate(value.resolvedAt, 'attention.resolvedAt') };
  await appendPrivateEvent('attention', event);
  return { resolved: id };
}

async function roundStatus(roundId = null) {
  const dir = await ensureStateDir();
  const events = await jsonLines(join(dir, 'rounds.ndjson'));
  const starts = events.filter((event) => event.type === 'started');
  const id = roundId ?? starts.at(-1)?.roundId;
  if (!id) throw new Error('No application round has been started.');
  const started = starts.find((event) => event.roundId === id);
  if (!started) throw new Error('Application round was not found.');
  const evidence = await roundEvidence(dir);
  const gates = roundGatesRecord(evidence, id);
  const roundSubmitted = (await jsonLines(join(dir, 'applications.ndjson')))
    .filter((entry) => entry.roundId === id && entry.status === 'submitted')
    .filter((entry) => !isFixtureOrSandboxApply(entry));
  // Gated rounds: an entry logged after the fact counts toward the target only with a per-job approval.
  const uncountedLoggedApplicationIds = [];
  const matching = [];
  for (const entry of roundSubmitted) {
    if (gates && isLoggedNotAgentFilled(entry)) {
      const batch = entry.reviewBatchId ? await loadBatch(dir, entry.reviewBatchId).catch(() => null) : null;
      if (!isPerJobApproval(batch)) { uncountedLoggedApplicationIds.push(entry.id); continue; }
    }
    matching.push(entry);
  }
  const applications = [...new Map(matching.map((entry, index) => [canonicalApplicationKey(entry, String(index)), entry])).values()];
  const delivery = deliveryProjection(matching, await jsonLines(join(dir, 'delivery.ndjson')));
  const effectiveKeys = new Set(matching.filter((entry,i) => delivery.applications[i].counted).map(canonicalApplicationKey));
  const effectiveApplications = applications.filter(entry => effectiveKeys.has(canonicalApplicationKey(entry)));
  const outreachView = await loadOutreachRoundView(dir, cloudState);
  const outreachCounts = projectOutreachRoundCounts({
    applications: matching,
    delivery,
    roundEvents: events,
    sentVerified: outreachView.sentVerified,
    invalidatedIds: outreachView.invalidatedIds,
    roundId: id,
  });
  const confirmedCount = outreachCounts.confirmedCount;
  const audit = started.discoveryPolicyVersion === 2 ? discoveryProjection(await jsonLines(join(dir, 'discovery.ndjson')), { roundId: id }) : null;
  const attention = await attentionList(id);
  const completion = events.find((event) => event.type === 'completed' && event.roundId === id);
  const discovery = { ...discoverySummary(events.filter((event) => event.roundId === id), effectiveApplications, completion, audit),
    ...(audit ? { reviewedCount: audit.reviewedCount, qualifiedCount: audit.qualifiedCount, uniqueLeadCount: audit.uniqueLeadCount, dispositionCounts: audit.dispositionCounts, conflicts: audit.conflicts,
      missingLeadApplicationIds: effectiveApplications.filter(app => !audit.leads.some(lead => !lead.conflict && lead.disposition === 'qualified' && lead.applicationId === app.id && lead.sourceId === (app.discoverySourceId ?? events.filter(e => e.type === 'source-checked' && e.applicationIds?.includes(app.id)).at(-1)?.sourceId) && (normalizedText(lead.company) === normalizedText(app.company) && (lead.employerJobId && app.employerJobId ? lead.employerJobId.toLowerCase() === app.employerJobId.toLowerCase() : canonicalUrl(lead.url) === canonicalUrl(app.url))))).map(app => app.id) } : { accounting: 'legacy-unverified' }) };
  let routineGates = null;
  if (gates) {
    const submitTimes = new Map(evidence.filter((item) => item.type === 'submit-recorded' && item.roundId === id).map((item) => [item.applicationId, item.at]));
    const coverage = evaluateRoundCoverage({
      gates, evidence, roundId: id,
      sourceEvents: events.filter((event) => event.type === 'source-checked' && event.roundId === id),
      leads: (await jsonLines(join(dir, 'discovery.ndjson'))).filter((event) => event.type === 'lead-reviewed' && event.roundId === id),
      submissions: effectiveApplications.map((entry) => ({ id: entry.id, at: submitTimes.get(entry.id) ?? entry.submittedAt })),
      group: discoveryGroup, minSources: MIN_DISCOVERY_SOURCES,
    });
    discovery.coverageSatisfied = discovery.coverageSatisfied && coverage.coverageSatisfied;
    const resumePreflight = resumePreflightRecord(evidence, id);
    routineGates = { enforced: true, resumePreflight, blockers: resumeBlockers(resumePreflight), uncountedLoggedApplicationIds, coverage };
  }
  return {
    roundId: id,
    requestedCount: started.requestedCount,
    confirmedCount,
    remainingCount: Math.max(0, started.requestedCount - confirmedCount),
    blockedCount: attention.count,
    completed: Boolean(completion),
    discoveryPolicyVersion: started.discoveryPolicyVersion ?? 1,
    recordedSubmissionCount: delivery.recordedSubmissionCount,
    applyConfirmationCount: outreachCounts.applyConfirmationCount,
    outreachConfirmationCount: outreachCounts.outreachConfirmationCount,
    effectiveSubmissionCount: delivery.effectiveSubmissionCount,
    failedDeliveryCount: delivery.failedDeliveryCount,
    receiptUnknownEmailCount: delivery.receiptUnknownEmailCount,
    shortfallCount: Math.max(0, started.requestedCount - confirmedCount),
    needsRecovery: Boolean(completion) && confirmedCount < started.requestedCount,
    discovery,
    ...(routineGates ? { routineGates } : {}),
    startedAt: started.occurredAt,
    ...(completion ? { completedAt: completion.occurredAt } : {}),
  };
}

async function roundComplete(input) {
  const value = object(input, 'round completion');
  const allowed = new Set(['roundId', 'completedAt', 'concentrationReason', 'concentrationEvidence']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown round completion property: ${key}.`);
  // Use the same lock order as ledger writes so completion cannot race a confirmed submission.
  const result = await withStateLock('applications', () => withStateLock('rounds', async (dir) => {
    const status = await roundStatus(string(value.roundId, 'round.roundId', 180));
    if (status.completed) return { ...status, completionRecorded: false };
    const uncounted = status.routineGates?.uncountedLoggedApplicationIds ?? [];
    if (status.confirmedCount < status.requestedCount) throw new Error(`Round requires ${status.requestedCount} confirmed submissions before completion.${uncounted.length ? ` ${uncounted.length} entryOrigin=logged ${uncounted.length === 1 ? 'entry is' : 'entries are'} not counted without a per-job approval (a one-application review batch).` : ''}`);
    if (status.routineGates?.enforced) {
      const coverage = status.routineGates.coverage;
      if (coverage.afterSubmissionSourceIds.length) throw new Error(afterSubmissionCoverageMessage(coverage.afterSubmissionSourceIds, coverage.lastSubmissionAt));
      if (!coverage.communityFeed.satisfied) throw new Error(communityFeedRequirementMessage());
    }
    if (!status.discovery.coverageSatisfied) throw new Error('Round requires attempts across at least 3 distinct discovery sources, including at least one searched source. Record coverage and blockers with round source --stdin.');
    if (status.discovery.unattributedCount) throw new Error('Round requires discovery source attribution for every confirmed submission. Supply missing attribution using round source applicationIds; do not rewrite the ledger.');
    if (status.discovery.conflicts?.length || status.discovery.missingLeadApplicationIds?.length) throw new Error('Round requires qualified lead records for every submission and resolution of conflicting assessments.');
    let explanation = {};
    if (status.discovery.concentrationNeedsExplanation || value.concentrationReason != null || value.concentrationEvidence != null) {
      if (!CONCENTRATION_REASONS.has(value.concentrationReason)) throw new Error('Source concentration requires a documented concentrationReason and private concentrationEvidence.');
      explanation = { concentrationReason: value.concentrationReason, concentrationEvidence: string(value.concentrationEvidence, 'round.concentrationEvidence', 2000) };
    }
    const event = { type: 'completed', roundId: status.roundId, occurredAt: isoDate(value.completedAt, 'round.completedAt'), ...explanation };
    const file = join(dir, 'rounds.ndjson');
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    const warnings = (status.routineGates?.blockers ?? []).map((item) => `${item.blocker}: ${item.reason} Report this blocker to the candidate with the round summary.`);
    return { ...status, discovery: { ...status.discovery, ...explanation }, completed: true, completionRecorded: true, completedAt: event.occurredAt, ...(warnings.length ? { warnings } : {}) };
  }));
  if (result.completionRecorded) await appendCloudEvent('rounds', { type: 'completed', roundId: result.roundId, occurredAt: result.completedAt, ...(result.discovery.concentrationReason ? { concentrationReason: result.discovery.concentrationReason, concentrationEvidence: result.discovery.concentrationEvidence } : {}) });
  return result;
}

async function roundConfirm(input) {
  const value = object(input, 'round confirmation');
  const allowed = new Set(['roundId', 'outreachId', 'outreachIds']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown round confirmation property: ${key}.`);
  const roundId = string(value.roundId, 'round.roundId', 180);
  const ids = [];
  if (value.outreachId != null) ids.push(string(value.outreachId, 'round.outreachId', 100));
  if (value.outreachIds != null) {
    if (!Array.isArray(value.outreachIds) || value.outreachIds.length === 0 || value.outreachIds.length > 50) throw new Error('round.outreachIds must be a bounded array of outreach IDs.');
    for (const [index, id] of value.outreachIds.entries()) ids.push(string(id, `round.outreachIds[${index}]`, 100));
  }
  if (!ids.length) throw new Error('round confirm requires outreachId or outreachIds.');
  const dir = await ensureStateDir();
  const uniqueIds = [...new Set(ids)];
  const roundEvents = await jsonLines(join(dir, 'rounds.ndjson'));
  const sentVerified = new Set((await loadSentVerifiedOutreach(dir, cloudState, { allowCache: false })).map((item) => item.id));
  for (const outreachId of uniqueIds) {
    const targetRoundId = resolveOutreachRoundId(roundEvents, { outreachId, roundId });
    if (!targetRoundId) throw new Error('Application round was not found.');
    const alreadyAttached = outreachConfirmationEvents(roundEvents, targetRoundId).some((event) => event.outreachId === outreachId);
    if (!alreadyAttached && !sentVerified.has(outreachId)) throw new Error(`Outreach ${outreachId} is not sent-verified.`);
  }
  const confirmations = [];
  for (const outreachId of uniqueIds) {
    const result = await confirmOutreachTowardRound({
      directory: dir,
      outreachId,
      roundId,
      cloudClient: cloudState,
      requireRoundId: true,
    });
    if (result.reason === 'round-not-found') throw new Error('Application round was not found.');
    if (result.reason === 'not-sent-verified') throw new Error(`Outreach ${outreachId} is not sent-verified.`);
    confirmations.push(result);
  }
  return { ...await roundStatus(roundId), confirmations };
}

async function frictionRecord(input) {
  const value = object(input, 'friction event');
  const allowed = new Set(['stage', 'ats', 'errorCode', 'reproducible', 'general', 'observedAt']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown friction property: ${key}.`);
  const stage = string(value.stage, 'friction.stage', 40).toLowerCase();
  const ats = string(value.ats, 'friction.ats', 40).toLowerCase();
  const errorCode = string(value.errorCode, 'friction.errorCode', 100).toLowerCase();
  if (!ATTENTION_STAGES.has(stage)) throw new Error('friction.stage is invalid.');
  if (!SOURCES.has(ats)) throw new Error('friction.ats is invalid.');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(errorCode)) throw new Error('friction.errorCode must be a stable kebab-case code.');
  if (typeof value.reproducible !== 'boolean' || typeof value.general !== 'boolean') throw new Error('friction.reproducible and friction.general must be Booleans.');
  const event = {
    id: `friction-${randomUUID()}`,
    type: 'observed',
    stage,
    ats,
    errorCode,
    reproducible: value.reproducible,
    general: value.general,
    qualifiesForPr: value.reproducible && value.general,
    observedAt: isoDate(value.observedAt, 'friction.observedAt'),
  };
  await appendPrivateEvent('friction', event);
  return event;
}

async function frictionList() {
  const items = (await jsonLines(join(await ensureStateDir(), 'friction.ndjson'))).filter((event) => event.type === 'observed');
  return { count: items.length, items, prCandidates: items.filter((item) => item.qualifiesForPr) };
}

async function ledgerOutcome(outcomeInput) {
  const input = object(outcomeInput, 'outcome');
  const allowed = new Set(['id', 'status', 'occurredAt', 'note', 'reasons', 'interviewQuality', 'failurePoint']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unknown outcome property: ${key}.`);
  const status = string(input.status, 'outcome.status', 40).toLowerCase();
  if (!['interview', 'rejected', 'offer', 'withdrawn'].includes(status)) throw new Error('Invalid outcome status.');
  const occurredAt = string(input.occurredAt ?? new Date().toISOString(), 'outcome.occurredAt', 80);
  if (Number.isNaN(Date.parse(occurredAt))) throw new Error('outcome.occurredAt must be an ISO date.');
  const reasonCategories = new Set(['eligibility', 'closed-stale', 'level-compensation', 'must-have-gap', 'generic-resume-screen', 'interview-stage', 'unknown']);
  const evidenceLevels = new Set(['explicit', 'inferred']);
  const reasons = input.reasons == null ? [] : input.reasons.map((item, index) => {
    const reason = object(item, `outcome.reasons[${index}]`);
    const category = string(reason.category, `outcome.reasons[${index}].category`, 80);
    const evidence = string(reason.evidence, `outcome.reasons[${index}].evidence`, 40);
    if (!reasonCategories.has(category)) throw new Error(`outcome.reasons[${index}].category is invalid.`);
    if (!evidenceLevels.has(evidence)) throw new Error(`outcome.reasons[${index}].evidence is invalid.`);
    return { category, evidence };
  });
  const interviewQuality = input.interviewQuality == null ? null : string(input.interviewQuality, 'outcome.interviewQuality', 40).toLowerCase();
  if (interviewQuality != null && !INTERVIEW_QUALITIES.has(interviewQuality)) throw new Error('outcome.interviewQuality is invalid.');
  const failurePoint = input.failurePoint == null ? null : string(input.failurePoint, 'outcome.failurePoint', 40).toLowerCase();
  if (failurePoint != null && !FAILURE_POINTS.has(failurePoint)) throw new Error('outcome.failurePoint is invalid.');
  if (failurePoint != null && interviewQuality == null) throw new Error('outcome.failurePoint requires outcome.interviewQuality.');
  const event = {
    id: string(input.id, 'outcome.id', 180), status, occurredAt,
    ...(typeof input.note === 'string' ? { note: input.note.slice(0, 2000) } : {}),
    ...(reasons.length ? { reasons } : {}),
    ...(interviewQuality ? { interviewQuality } : {}),
    ...(failurePoint ? { failurePoint } : {}),
  };
  const storage = await withStateLock('outcomes', async (dir) => {
    const file = join(dir, 'outcomes.ndjson');
    const existing = await jsonLines(file);
    const sameOccurrence = existing.filter((item) => item.id === event.id && item.status === event.status && item.occurredAt === event.occurredAt);
    const detailKey = (item) => JSON.stringify({ reasons: item.reasons ?? [], interviewQuality: item.interviewQuality ?? null, failurePoint: item.failurePoint ?? null });
    const duplicate = sameOccurrence.some((item) => detailKey(item) === detailKey(event));
    if (duplicate) return { stored: false, enriched: false };
    const enriched = sameOccurrence.length > 0;
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return { stored: true, enriched };
  });
  const applications = await jsonLines(join(await ensureStateDir(), 'applications.ndjson'));
  if (storage.stored && await cloudState.configured()) {
    await cloudState.appendRecord('outcomes', event, {
      recordKey: event.id,
      idempotencyKey: `outcome:${event.id}:${event.status}:${event.occurredAt}:${createHash('sha256').update(JSON.stringify(event)).digest('hex')}`,
      occurredAt: event.occurredAt,
      queueOnFailure: true,
    });
  }
  return { result: { recorded: storage.stored, duplicate: !storage.stored, enriched: storage.enriched, recordedOutcome: event.id, status }, application: applications.find((entry) => entry.id === event.id) ?? null, event };
}

async function ledgerReview() {
  const dir = await ensureStateDir();
  const applications = await jsonLines(join(dir, 'applications.ndjson'));
  const outcomes = await jsonLines(join(dir, 'outcomes.ndjson'));
  const acknowledgements = await jsonLines(join(dir, 'reviews.ndjson'));
  const review = buildReview(applications, outcomes, acknowledgements, new Date(), await jsonLines(join(dir, 'delivery.ndjson')));
  // Local-only review markers; reviewTelemetry() never reads this key.
  const fillTelemetryReview = await fillTelemetryReviewFlags(dir);
  if (fillTelemetryReview.length) review.fillTelemetryReviewFlags = fillTelemetryReview;
  return review;
}

async function ledgerReviewAcknowledge(input) {
  const value = object(input, 'review acknowledgement');
  const reviewedAt = string(value.reviewedAt ?? new Date().toISOString(), 'reviewedAt', 80);
  if (Number.isNaN(Date.parse(reviewedAt))) throw new Error('reviewedAt must be an ISO date.');
  const review = await ledgerReview();
  const event = { reviewedAt, uniqueSubmissionCount: review.recordedSubmissionCount, maturedApplicationCount: review.recordedMaturedApplicationCount };
  await withStateLock('reviews', async (dir) => {
    const file = join(dir, 'reviews.ndjson');
    await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
  });
  if (await cloudState.configured()) await cloudState.appendRecord('reviews', event, { recordKey: reviewedAt, idempotencyKey: `review:${reviewedAt}`, occurredAt: reviewedAt, queueOnFailure: true });
  return { acknowledged: true, ...event };
}

async function prepareCloudState(area, action) {
  if (!await cloudState.configured() || area === 'cloud') return;
  try {
    await cloudState.reconcile({ dryRun: false, provenance: 'automatic-recovery' });
    await cloudState.refreshDocumentCaches();
  } catch (error) {
    // New submissions still fail closed because lease and intent operations
    // call the cloud directly. Local checks, research, and observed-result
    // ledger appends can continue and queue their idempotent recovery writes.
    // Treat transport and HTTP relay failures the same for automatic recovery.
    if (!/^Cloud state (unavailable|request failed)/.test(error.message)) throw error;
  }
}

async function cloudCommand(action, value) {
  if (action === 'configure' && value === '--stdin') {
    const configured = await saveCloudConfig(await jsonStdin(), { configPath: cloudConfigPath() });
    const updateGuard = await enableCloudUpdateGuard();
    return { configured: true, url: configured.url, clientId: configured.clientId ?? null, clientName: configured.clientName ?? null, token: configured.token, updateGuard };
  }
  if (action === 'status' && value == null) return cloudState.status();
  if (action === 'reconcile' && value === '--dry-run') return cloudState.reconcile({ dryRun: true });
  if (action === 'reconcile' && value == null) return cloudState.reconcile({ dryRun: false });
  if (action === 'export') return cloudState.exportTo(value ?? null);
  if (action === 'lease-acquire' && value == null) {
    const lease = await cloudState.acquireLease();
    await writePrivateJson(join(await ensureStateDir(), 'cloud-lease.json'), lease);
    return lease;
  }
  // Agents often pass the lease ID they were given; accept it when it names the recorded local lease.
  if (action === 'lease-renew' && (value == null || typeof value === 'string')) {
    const lease = await readPrivateJson(join(await ensureStateDir(), 'cloud-lease.json'), null);
    if (value != null && lease?.leaseId && value !== lease.leaseId) throw new Error('The given lease ID does not match the recorded local lease. Run cloud lease-renew without arguments.');
    if (!lease?.leaseId) throw new Error('No local cloud lease is recorded. Run cloud lease-acquire.');
    const renewed = await cloudState.renewLease(lease.leaseId);
    await writePrivateJson(join(await ensureStateDir(), 'cloud-lease.json'), renewed);
    return renewed;
  }
  if (action === 'lease-release' && (value == null || typeof value === 'string')) {
    const lease = await readPrivateJson(join(await ensureStateDir(), 'cloud-lease.json'), null);
    if (value != null && lease?.leaseId && value !== lease.leaseId) throw new Error('The given lease ID does not match the recorded local lease. Run cloud lease-release without arguments.');
    if (!lease?.leaseId) throw new Error('No local cloud lease is recorded.');
    return cloudState.releaseLease(lease.leaseId);
  }
  if (action === 'intent-prepare' && value === '--stdin') {
    const { reviewBatchId, reviewToken, ...body } = object(await jsonStdin(), 'intent');
    if (requiresBatchReview(body.canonicalUrl)) {
      await verifyReview(await ensureStateDir(), { reviewBatchId, reviewToken }, {
        action: 'cloud intent-prepare',
        match: applicationMatcher({ applicationId: body.applicationId, url: body.canonicalUrl, purpose: body.retry === true ? 'retry' : 'submit' }),
        checkResume: true,
        resumeSha256: (await currentResumeDigest())?.sha256,
      });
    }
    return cloudState.createIntent(body);
  }
  if (action === 'intent-sent' && value === '--stdin') {
    const input = await jsonStdin();
    return cloudState.markIntentSentUnverified(string(input.intentId, 'intentId', 200), string(input.leaseId, 'leaseId', 200));
  }
  if (action === 'intent-confirm' && value === '--stdin') {
    const { reviewBatchId, reviewToken, ...input } = object(await jsonStdin(), 'intent');
    const application = object(input.application, 'application');
    // Confirming an intent records the application, so it needs the same approval as ledger add.
    let reviewed = null;
    const dir = await ensureStateDir();
    if (requiresBatchReview(application.url)) {
      reviewed = await verifyReview(dir, { reviewBatchId, reviewToken }, {
        action: 'cloud intent-confirm',
        match: applicationMatcher({ applicationId: application.id, url: application.url, answers: application.answers ?? {} }),
        checkResume: true,
        resumeSha256: (await currentResumeDigest())?.sha256,
      });
    }
    const confirmed = await cloudState.confirmIntent(string(input.intentId, 'intentId', 200), application, string(input.leaseId, 'leaseId', 200), input.idempotencyKey);
    if (reviewed) await consumeReview(dir, reviewed.batch.batchId, reviewed.item.itemId, 'cloud-intent-confirm');
    return confirmed;
  }
  throw usageError(['cloud', action, value]);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function outcomeTelemetry(application, outcome) {
  if (!application) return null;
  const identity = await jobIdentity(application.url);
  return {
    event: 'outcome_recorded',
    properties: {
      ...identity,
      company: application.company,
      title: application.role,
      ats: sourceToAts(application.applicationChannel ?? application.source),
      outcome: outcome.status,
      daysSinceSubmission: Math.max(0, Math.min(3650, Math.floor((Date.parse(outcome.occurredAt) - Date.parse(application.submittedAt)) / 86_400_000))),
      ...(outcome.interviewQuality ? { interviewQuality: outcome.interviewQuality } : {}),
      ...(outcome.failurePoint ? { failurePoint: outcome.failurePoint } : {}),
    },
  };
}

function reviewTelemetry(review) {
  return {
    event: 'review_generated',
    properties: {
      submissionCount: review.submittedTotal,
      interviewCount: review.outcomeCounts.interview,
      rejectionCount: review.outcomeCounts.rejected,
      offerCount: review.outcomeCounts.offer,
      withdrawalCount: review.outcomeCounts.withdrawn,
      reviewDue: review.reviewDue,
    },
  };
}

function roundCompletedTelemetry(round) {
  const applicationCount = round.applyConfirmationCount ?? round.effectiveSubmissionCount ?? 0;
  return {
    event: 'round_completed',
    properties: {
      requestedCount: round.requestedCount,
      submittedCount: applicationCount,
      assessedCount: applicationCount,
      skippedCount: 0,
      pausedCount: round.blockedCount,
      errorCount: 0,
      durationBucket: durationBucket(Math.max(0, Date.parse(round.completedAt) - Date.parse(round.startedAt))),
      attemptedSourceCount: round.discovery.attemptedSourceCount,
      searchedSourceCount: round.discovery.searchedSourceCount,
      blockedSourceCount: round.discovery.blockedSourceCount,
      maxSourceSharePercent: round.discovery.maxSourceSharePercent,
      ...(round.discovery.concentrationReason ? { concentrationReason: round.discovery.concentrationReason } : {}),
    },
  };
}

async function emitDomainEvent(telemetry, session, event) {
  if (!event) return;
  await telemetry.record(event, session);
}

async function executeCommand([area, action, value], telemetry, session, community) {
  let result;
  if (area === 'cloud') result = await cloudCommand(action, value);
  else if (area === 'profile' && action === 'set' && value === '--stdin') {
    const profile = await jsonStdin();
    result = await profileSet(profile);
  } else if (area === 'profile' && action === 'migrate' && value === '--stdin') {
    result = await profileMigrate(await jsonStdin());
  } else if (area === 'profile' && action === 'check') {
    result = { ...profileStatus(storedProfileRaw()), required: REQUIRED_PROFILE };
  } else if (area === 'profile' && action === 'field' && value) {
    if (![...STRING_PROFILE_FIELDS, ...ARRAY_PROFILE_FIELDS, ...NUMBER_PROFILE_FIELDS, ...OBJECT_PROFILE_FIELDS].includes(value)) throw new Error('Profile field is not allowed.');
    result = { [value]: storedProfile()[value] ?? null };
  } else if (area === 'resume' && action === 'import' && value) result = await importResume(value);
  else if (area === 'resume' && action === 'path' && value == null) result = await canonicalResumePath();
  else if (area === 'score' && action === 'guard' && value == null) result = await assessmentGuard().status(writePrivateJson);
  else if (area === 'score' && action === 'guard-reset' && value == null) result = await assessmentGuard().reset(writePrivateJson);
  else if (area === 'score' && action === '--stdin') {
    const guard = assessmentGuard();
    let ticket = null;
    let job;
    let profile;
    try {
      job = await jsonStdin();
      profile = job.target ?? storedProfile();
      ticket = await guard.before(job, profile, writePrivateJson);
      if (ticket.cached) {
        // Identical input for a job already scored in this run: return the earlier result and
        // emit no assessment telemetry, so a re-scoring loop cannot inflate analytics.
        return {
          ...ticket.cached,
          repeatAssessment: true,
          firstAssessedAt: ticket.firstAssessedAt,
          notice: 'This job was already scored with the same input in this run; this is the earlier result. Do not score it again.',
        };
      }
      result = scoreJob(job, profile);
    } catch (error) {
      if (isAssessmentGuardStop(error)) throw error;
      const status = await guard.failure(ticket, error, { invalidInput: telemetryErrorCode(error) === 'invalid_input' }, writePrivateJson).catch(() => null);
      if (status?.jobBlocked) {
        await recordAssessmentBlock(job);
        error.message = `${error.message} ${invalidJobMessage(status.jobBlocked.count, status.jobBlocked.lastMessage)}`;
      }
      if (status?.stopped && status.stopReason === 'invalid_input') {
        error.message = `${error.message} Assessment guard: ${status.consecutiveInvalidInput} score calls in a row failed with invalid input; further score calls are refused until ${status.stoppedUntil}. STOP the run, fix the job JSON, and tell the user.`;
      }
      throw error;
    }
    result.assessmentGuard = await guard.success(ticket, result, writePrivateJson);
    await recordAssessmentDecision(job, result);
    await emitDomainEvent(telemetry, session, await telemetryJobAssessed(job, result));
    if (result.decision === 'skip' || result.decision === 'exclude') {
      await recordAssessmentSkip(job, result);
      await emitDomainEvent(telemetry, session, await telemetryApplicationSkipped(job, result));
    } else if (result.decision === 'review') {
      await emitDomainEvent(telemetry, session, await telemetryApplicationStarted(job, {
        approvalMode: profile.submissionMode,
        ats: job.applicationChannel ?? job.source,
        requiredFieldCount: job.requiredFieldCount,
        resumeRequired: job.resumeRequired,
        coverLetterRequired: job.coverLetterRequired,
        referralPresent: job.referralPresent,
      }));
    }
  } else if (area === 'ledger' && action === 'check' && value === '--stdin') result = await ledgerCheck(await jsonStdin());
  else if (area === 'ledger' && action === 'delivery' && value === '--stdin') result = await recordDelivery(await jsonStdin());
  else if (area === 'ledger' && action === 'retry' && value === '--stdin') result = await recordDelivery(await jsonStdin(), true);
  else if (area === 'ledger' && action === 'deliveries') result = await deliveryHistory(value);
  else if (area === 'ledger' && action === 'add' && value === '--stdin') {
    const input = await jsonStdin();
    const telemetryDetails = validateSubmissionTelemetry(input.telemetry);
    const baseEntry = validateLedgerEntry(input);
    const fillMetrics = resolveSubmissionFillMetrics(baseEntry, telemetryDetails);
    const jobApprovalMode = normalizeJobApprovalMode(input.jobApprovalMode);
    // Read the stored profile only for thin submits so filled submits never depend on profile storage.
    const profileSubmissionMode = isThinSubmission(baseEntry, fillMetrics) ? storedSubmissionModeOrNull() : null;
    const fillGuard = assertSubmissionFillGuard(baseEntry, fillMetrics, input.thinSubmissionOverride, { profileSubmissionMode, jobApprovalMode });
    // After the empty-submit guard (its refusal is the more basic one), before anything is recorded.
    assertResumeFieldPresentReported(input.telemetry);
    if (fillGuard.thinSubmissionOverrideUsed) {
      await assertAndRecordThinOverrideUse(fillGuard.candidateConfirmation, baseEntry.url);
    }
    const telemetrySupplied = fillMetrics.fillMetricsSource === 'telemetry';
    warnAnswerKeyFillMetricsFallback(fillMetrics.fillMetricsSource);
    // entryOrigin is derived here, never taken from the caller: only an answer-key fallback
    // (no fill telemetry) marks the entry as logged after the fact / not agent-filled.
    const { entryOrigin: _callerEntryOrigin, ...ledgerInput } = input;
    const entry = validateLedgerEntry({
      ...ledgerInput,
      fillMetricsSource: fillMetrics.fillMetricsSource,
      telemetrySupplied,
      ...(fillMetrics.entryOrigin ? { entryOrigin: fillMetrics.entryOrigin } : {}),
    });
    const review = requiresBatchReview(entry.url)
      ? { credentials: { reviewBatchId: input.reviewBatchId, reviewToken: input.reviewToken }, resumeSha256: (await currentResumeDigest())?.sha256 }
      : null;
    const routineAuto = review ? await isRoutineAutoSend(entry) : false;
    result = await ledgerAdd(entry, input.duplicateOverride, input.companyReapplyOverride, input.cloudIntentId && input.cloudLeaseId ? { intentId: input.cloudIntentId, leaseId: input.cloudLeaseId } : null, review, { routineAuto });
    result.communityJob = await communityJobsSync(community, { limit: 1, applicationIds: [entry.id] });
    const fillTelemetryReview = telemetrySupplied ? await reviewRapidFireFillTelemetry(entry, input.telemetry) : null;
    if (fillTelemetryReview) result.fillTelemetryReview = fillTelemetryReview;
    if (!isFixtureOrSandboxApply(entry)) {
      const identity = await jobIdentity(entry.url);
      const lifecycleStartedAt = await telemetry.applicationStartedAt?.(identity.jobHash);
      await emitDomainEvent(telemetry, session, await telemetryApplicationSubmitted(entry, {
        ...fillMetrics,
        telemetrySupplied,
        thinSubmissionOverrideUsed: fillGuard.thinSubmissionOverrideUsed === true,
        ...(lifecycleStartedAt ? { lifecycleStartedAt } : {}),
      }));
    }
  } else if (area === 'ledger' && action === 'outcome' && value === '--stdin') {
    const outcome = await ledgerOutcome(await jsonStdin());
    result = outcome.result;
    if (outcome.result.recorded && !outcome.result.enriched) {
      await emitDomainEvent(telemetry, session, await outcomeTelemetry(outcome.application, outcome.event));
    }
  } else if (area === 'ledger' && action === 'review') {
    result = await ledgerReview();
    await emitDomainEvent(telemetry, session, reviewTelemetry(result));
  } else if (area === 'ledger' && action === 'review-ack' && value === '--stdin') {
    result = await ledgerReviewAcknowledge(await jsonStdin());
  } else if (area === 'autonomy' && action === 'grant' && value === '--stdin') result = await autonomyGrant(await jsonStdin());
  else if (area === 'autonomy' && action === 'status' && value == null) result = await autonomyStatus();
  else if (area === 'autonomy' && action === 'preview' && value == null) result = await autonomyStatus();
  else if (area === 'autonomy' && action === 'revoke' && value == null) result = await autonomyRevoke();
  else if (area === 'round' && action === 'start' && value === '--stdin') result = await roundStart(await jsonStdin());
  else if (area === 'round' && action === 'lead' && value === '--stdin') result = await recordLead(await jsonStdin());
  else if (area === 'round' && action === 'leads') result = await leadHistory(value);
  else if (area === 'round' && action === 'source' && value === '--stdin') {
    result = await roundSource(await jsonStdin());
    await emitDomainEvent(telemetry, session, { event: 'source_checked', properties: {
      sourceId: result.sourceId.startsWith('community-') ? 'community' : result.sourceId,
      status: result.status, reviewedCount: result.reviewedCount, qualifiedCount: result.qualifiedCount,
      ...(result.blocker ? { blocker: result.blocker } : {}),
    } });
  }
  else if (area === 'round' && action === 'status') result = await roundStatus(value ?? null);
  else if (area === 'round' && action === 'confirm' && value === '--stdin') result = await roundConfirm(await jsonStdin());
  else if (area === 'round' && action === 'complete' && value === '--stdin') {
    result = await roundComplete(await jsonStdin());
    if (result.completionRecorded) await emitDomainEvent(telemetry, session, roundCompletedTelemetry(result));
  } else if (area === 'sources' && action === 'list' && value == null) {
    await syncAllCommunityData(community);
    result = await sourcesList({}, await community.list());
  } else if (area === 'sources' && action === 'list' && value === '--stdin') {
    const filters = await jsonStdin();
    await syncAllCommunityData(community);
    result = await sourcesList(filters, await community.list());
  }
  else if (area === 'sources' && action === 'suggest' && value === '--stdin') result = await sourcesSuggest(await jsonStdin(), community);
  else if (area === 'sources' && action === 'pending' && value == null) result = await communityPendingStatus();
  else if (area === 'sources' && action === 'sync' && value == null) result = await syncAllCommunityData(community);
  else if (area === 'sources' && action === 'jobs' && (value == null || value === '--stdin')) {
    result = await community.listJobs(value === '--stdin' ? await jsonStdin() : undefined);
    // Recorded locally so `round source`/`round complete` can verify the community feed was pulled.
    if (!await recordCommunityFeedPull(community, result)) result = { ...result, communityFeedUnavailable: true };
  }
  else if (area === 'sources' && action === 'sharing' && ['status', 'enable', 'disable', 'reset'].includes(value)) {
    result = await community.configure(value);
    if (value === 'enable') result.communityJobs = await communityJobsSync(community);
  }
  else if (area === 'attention' && action === 'add' && value === '--stdin') {
    result = await attentionAdd(await jsonStdin());
    let ats;
    if (result.applicationId) {
      try {
        const apps = await jsonLines(join(await ensureStateDir(), 'applications.ndjson'));
        const match = apps.find((entry) => entry.id === result.applicationId);
        if (match) ats = match.applicationChannel ?? match.source;
      } catch { /* best-effort ATS for pause telemetry only */ }
    }
    await emitDomainEvent(telemetry, session, await telemetryApplicationPaused(result, { ats }));
  } else if (area === 'attention' && action === 'list' && value == null) result = await attentionList();
  else if (area === 'attention' && action === 'resolve' && value === '--stdin') result = await attentionResolve(await jsonStdin());
  else if (area === 'friction' && action === 'record' && value === '--stdin') result = await frictionRecord(await jsonStdin());
  else if (area === 'friction' && action === 'list' && value == null) result = await frictionList();
  else if (area === 'review') result = await reviewCommand(action, value);
  else throw usageError([area, action, value]);
  return result;
}

async function recordInstallationStart(telemetry, session) {
  if (!session.installationEventPending) return;
  let submissionMode = 'unconfigured';
  try { submissionMode = storedProfile().submissionMode; } catch {}
  await telemetry.record({
    event: 'installation_started',
    properties: {
      osFamily: ({ darwin: 'macos', linux: 'linux', win32: 'windows' })[platform()] ?? 'other',
      nodeMajor: Number(process.versions.node.split('.')[0]),
      submissionMode,
    },
  }, session);
}

async function main(rawArgs) {
  const normalized = normalizeCliArgs(rawArgs);
  if (normalized.help) return print(usageFor(normalized.help === true ? null : normalized.help));
  if (normalized.version) return print({ version: SKILL_VERSION });
  const args = rawArgs[0] === 'outreach' ? rawArgs : normalized.args;
  inlineJsonInput = rawArgs[0] === 'outreach' ? undefined : normalized.inlineJson;
  const [area, action, value] = args;
  // Outreach is private-only, including errors: never initialize telemetry or
  // community clients, flush their queues, or run generic reconciliation here.
  if (area === 'outreach') {
    const { runOutreach } = await import('./outreach-cli.mjs');
    return print(await runOutreach(args.slice(1)));
  }
  // Notify-only update check: reads the public npm registry, never installs, and
  // stays outside telemetry and community sync.
  if (area === 'updates') {
    if (action === 'check' && args.length === 2) {
      const { checkForUpdate } = await import('./update-check.mjs');
      return print(await checkForUpdate());
    }
    throw usageError(['updates', action]);
  }
  // Name/email go only to the private /v1/contact store — never to PostHog event payloads.
  const telemetry = new TelemetryClient({ stateDir: stateDir(), readIdentity: () => {
    try {
      const profile = storedProfileRaw();
      return Object.fromEntries(['name', 'email'].filter((key) => typeof profile[key] === 'string' && profile[key].trim()).map((key) => [key, profile[key]]));
    } catch {
      return undefined;
    }
  } });
  const community = new SourceCommunityClient({ stateDir: stateDir() });
  if (area === 'telemetry') {
    if (action === 'contact' && ['status', 'enable', 'disable'].includes(value) && args.length === 3) return print(await telemetry.configureContact(value));
    if (action === 'identity' && ['status', 'enable', 'disable'].includes(value) && args.length === 3) return print(await telemetry.configureIdentity(value));
    if (['status', 'enable', 'disable', 'reset'].includes(action) && value == null) return print(await telemetry.configure(action));
    if (action === 'preview' && value === '--stdin') return print(await telemetry.preview(await jsonStdin()));
    if (action === 'record' && value === '--stdin') {
      const session = await telemetry.beginCommand('telemetry');
      await recordInstallationStart(telemetry, session);
      return print(await telemetry.record(await jsonStdin(), session, { strict: true }));
    }
    throw usageError(['telemetry', action, value]);
  }

  const command = commandCategory(args);
  const session = await telemetry.beginCommand(command);
  await recordInstallationStart(telemetry, session);
  const started = Date.now();
  try {
    await prepareCloudState(area, action);
    const result = await executeCommand(args, telemetry, session, community);
    if (!(area === 'sources' || (area === 'ledger' && action === 'add'))) await communityJobsSync(community).catch(() => null);
    await telemetry.record({ event: 'command_completed', properties: { command, result: 'success', durationBucket: durationBucket(Date.now() - started) } }, session);
    return print(result);
  } catch (error) {
    // Repeated guard refusals are not new information; report only the first one of each stop.
    if (error?.suppressTelemetry === true) throw error;
    await telemetry.record({ event: 'skill_error', properties: skillErrorProperties(error, command) }, session);
    await telemetry.record({ event: 'command_completed', properties: { command, result: 'error', durationBucket: durationBucket(Date.now() - started) } }, session);
    throw error;
  }
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
