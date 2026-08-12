#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { TelemetryClient } from './telemetry-client.mjs';
import { jobIdentity } from './telemetry-schema.mjs';

const KEYCHAIN_SERVICE = process.env.JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE ?? 'com.openai.codex.job-application-agent';
const KEYCHAIN_ACCOUNT = 'profile';
const DEFAULT_STATE_DIR = join(homedir(), 'Library/Application Support/Codex/job-application-agent');
const SOURCES = new Set(['linkedin', 'greenhouse', 'lever', 'ashby', 'workable', 'comeet', 'workday', 'rippling', 'smartrecruiters', 'google-form', 'company', 'email', 'other']);
const ELIGIBILITY = new Set(['eligible', 'unclear', 'ineligible']);
const APPROVALS = new Set(['APPROVE SUBMIT', 'STANDING AUTHORIZATION']);
const MODES = new Set(['review-each', 'routine-auto']);
const TELEMETRY_DURATIONS = new Set(['under-1s', '1-5s', '5-30s', '30-60s', '1-2m', '2-5m', '5-15m', '15m-plus']);
const REQUIRED_PROFILE = ['name', 'email', 'phone', 'location', 'workAuthorization', 'roleFamilies', 'seniority', 'targetLocations', 'workModes', 'submissionMode'];
const STRING_PROFILE_FIELDS = new Set(['name', 'email', 'phone', 'location', 'workAuthorization', 'linkedin', 'github', 'portfolio', 'availability', 'currentCompensation', 'targetCompensation', 'submissionMode']);
const ARRAY_PROFILE_FIELDS = new Set(['roleFamilies', 'seniority', 'skills', 'targetLocations', 'excludedLocations', 'workModes', 'industries', 'excludedCompanies']);

function stateDir() {
  return process.env.JOB_APPLICATION_AGENT_STATE_DIR || DEFAULT_STATE_DIR;
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
  if (area === 'profile') return 'profile';
  if (area === 'resume') return 'resume';
  if (area === 'score') return 'assess';
  if (area === 'ledger' && action === 'add') return 'apply';
  if (area === 'ledger' && action === 'outcome') return 'outcome';
  if (area === 'ledger' && action === 'review') return 'review';
  if (area === 'ledger') return 'apply';
  if (area === 'telemetry') return 'telemetry';
  return 'other';
}

function telemetryStage(command) {
  return ({ search: 'discovery', assess: 'assessment', apply: 'submission', outcome: 'outcome', review: 'review', resume: 'resume', profile: 'contact', onboard: 'contact' })[command] ?? 'application';
}

function telemetryErrorCode(error) {
  const message = String(error?.message ?? '');
  if (/keychain|authentication|login/i.test(message)) return 'authentication_required';
  if (/network|fetch|http/i.test(message)) return 'network_failure';
  if (/invalid|must|required|expected|unsupported/i.test(message)) return 'invalid_input';
  return 'internal_error';
}

function sourceToAts(source) {
  return SOURCES.has(source) ? source : 'other';
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
      ats: sourceToAts(String(job.source).toLowerCase()),
      fitScore: result.score,
      eligibility: String(job.eligibility).toLowerCase(),
      decision: result.decision,
      ...assessmentTags(result),
    },
  };
}

async function telemetryApplicationSubmitted(entry, details = {}) {
  const identity = await jobIdentity(entry.url);
  const answers = Object.keys(entry.answers ?? {});
  return {
    event: 'application_submitted',
    properties: {
      ...identity,
      company: entry.company,
      title: entry.role,
      ats: sourceToAts(entry.source),
      durationBucket: details.durationBucket ?? 'under-1s',
      fieldsFilled: details.fieldsFilled ?? answers.length,
      shortAnswerCount: details.shortAnswerCount ?? answers.filter((key) => !/resume|attachment/i.test(key)).length,
      resumeUploaded: details.resumeUploaded ?? answers.some((key) => /resume|attachment/i.test(key)),
      approvalMode: entry.approval === 'STANDING AUTHORIZATION' ? 'routine-auto' : 'review-each',
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

function stringArray(value, label, required = false) {
  if (!Array.isArray(value) || (required && value.length === 0)) throw new Error(`${label} must be ${required ? 'a non-empty' : 'an'} array of strings.`);
  return value.map((item, index) => string(item, `${label}[${index}]`, 300));
}

function normalizeUrl(value) {
  const url = new URL(string(value, 'url', 2048));
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|gh_src|source|ref|trk)/i.test(key)) url.searchParams.delete(key);
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
    else string(profile[field], `profile.${field}`, 1000);
  }
  if (!MODES.has(profile.submissionMode)) throw new Error('profile.submissionMode must be review-each or routine-auto.');
  for (const field of STRING_PROFILE_FIELDS) if (profile[field] != null) string(profile[field], `profile.${field}`, 2000);
  for (const field of ARRAY_PROFILE_FIELDS) if (profile[field] != null) stringArray(profile[field], `profile.${field}`);
  const allowed = new Set([...STRING_PROFILE_FIELDS, ...ARRAY_PROFILE_FIELDS]);
  return Object.fromEntries(Object.entries(profile).filter(([key]) => allowed.has(key)));
}

export function scoreJob(input, target) {
  const job = object(input, 'job');
  const profile = validateProfile(target);
  const title = string(job.title, 'job.title', 300);
  const company = string(job.company, 'job.company', 300);
  const description = string(job.description, 'job.description', 40000);
  const source = string(job.source, 'job.source', 40).toLowerCase();
  const eligibility = string(job.eligibility, 'job.eligibility', 40).toLowerCase();
  if (!SOURCES.has(source)) throw new Error('job.source is invalid.');
  if (!ELIGIBILITY.has(eligibility)) throw new Error('job.eligibility must be eligible, unclear, or ineligible.');

  const excludedCompany = terms(profile.excludedCompanies ?? []).some((name) => company.toLowerCase().includes(name));
  if (eligibility === 'ineligible' || excludedCompany) {
    return { score: 0, decision: 'exclude', reasons: [], gaps: [excludedCompany ? 'Company is excluded by the candidate.' : 'Posting is explicitly ineligible.'] };
  }

  const text = `${title}\n${description}`.toLowerCase();
  const locations = Array.isArray(job.locations) ? job.locations.join(' ').toLowerCase() : '';
  let score = 0;
  const reasons = [];
  const gaps = [];

  const roleMatches = matchesAny(title.toLowerCase(), profile.roleFamilies);
  if (roleMatches.length) { score += 30; reasons.push(`Role family: ${roleMatches.join(', ')}.`); }
  else gaps.push('Title does not directly match a target role family.');

  const seniorityMatches = matchesAny(title.toLowerCase(), profile.seniority);
  if (seniorityMatches.length) { score += 20; reasons.push(`Seniority: ${seniorityMatches.join(', ')}.`); }
  else gaps.push('Seniority does not directly match the target.');

  const skillMatches = matchesAny(text, profile.skills ?? []);
  if (skillMatches.length) {
    score += Math.min(25, skillMatches.length * 5);
    reasons.push(`Skills: ${skillMatches.slice(0, 6).join(', ')}.`);
  } else if ((profile.skills ?? []).length) gaps.push('No configured skill keywords found.');

  const industryMatches = matchesAny(text, profile.industries ?? []);
  if (industryMatches.length) { score += Math.min(10, industryMatches.length * 5); reasons.push(`Industry: ${industryMatches.join(', ')}.`); }

  const excludedLocation = terms(profile.excludedLocations ?? []).some((place) => locations.includes(place));
  if (excludedLocation) return { score: 0, decision: 'exclude', reasons, gaps: [...gaps, 'Posting is in an excluded location.'] };
  const locationMatches = matchesAny(locations, profile.targetLocations);
  const remoteWanted = terms(profile.workModes).includes('remote');
  if (locationMatches.length || (job.remote === true && remoteWanted)) {
    score += 15;
    reasons.push(job.remote === true ? 'Remote-compatible.' : `Target location: ${locationMatches.join(', ')}.`);
  } else gaps.push('Location or work mode is not an explicit match.');

  if (eligibility === 'unclear') {
    gaps.push('Work eligibility or location needs candidate confirmation.');
    return { score: Math.min(score, 100), decision: 'ask', reasons, gaps };
  }
  const finalScore = Math.min(score, 100);
  return { score: finalScore, decision: finalScore >= 60 ? 'review' : 'skip', reasons, gaps };
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
  if (!SOURCES.has(normalized.source)) throw new Error('entry.source is invalid.');
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

export function validateSubmissionTelemetry(input) {
  if (input == null) return {};
  const value = object(input, 'entry.telemetry');
  const allowed = new Set(['durationBucket', 'fieldsFilled', 'shortAnswerCount', 'resumeUploaded']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown entry.telemetry property: ${key}.`);
  if (value.durationBucket != null && !TELEMETRY_DURATIONS.has(value.durationBucket)) throw new Error('entry.telemetry.durationBucket is invalid.');
  for (const [key, max] of [['fieldsFilled', 500], ['shortAnswerCount', 100]]) {
    if (value[key] != null && (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > max)) throw new Error(`entry.telemetry.${key} must be an integer from 0 to ${max}.`);
  }
  if (value.resumeUploaded != null && typeof value.resumeUploaded !== 'boolean') throw new Error('entry.telemetry.resumeUploaded must be a Boolean.');
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item != null));
}

export function buildReview(entries) {
  const submissions = entries.filter((entry) => !Number.isNaN(Date.parse(entry.submittedAt)));
  const outcomes = entries.filter((entry) => ['interview', 'rejected', 'offer', 'withdrawn'].includes(entry.status));
  return {
    reviewDue: submissions.length > 0 && submissions.length % 10 === 0,
    submittedTotal: submissions.length,
    outcomeCounts: Object.fromEntries(['interview', 'rejected', 'offer', 'withdrawn'].map((status) => [status, outcomes.filter((entry) => entry.status === status).length])),
    autoAppliedChanges: false,
    nextStep: submissions.length > 0 && submissions.length % 10 === 0
      ? 'Propose evidence-based targeting and answer-guidance changes for candidate approval.'
      : 'Continue recording confirmed submissions and outcomes.',
  };
}

function decodeKeychain(value) {
  const trimmed = value.trim();
  return /^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 ? Buffer.from(trimmed, 'hex').toString('utf8') : value;
}

function keychainProfile() {
  if (process.platform !== 'darwin') throw new Error('Secure profile storage currently requires macOS Keychain.');
  const value = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try { return validateProfile(JSON.parse(decodeKeychain(value))); } catch { throw new Error('The Keychain profile is missing or invalid. Run profile set again.'); }
}

async function ensureStateDir() {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  return dir;
}

async function stdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function jsonStdin() {
  try { return JSON.parse(await stdin()); } catch { throw new Error('Expected one JSON object on standard input.'); }
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

async function profileSet(profileInput) {
  if (process.platform !== 'darwin') throw new Error('Secure profile storage currently requires macOS Keychain.');
  const profile = validateProfile(profileInput);
  const raw = JSON.stringify(profile);
  try {
    execFileSync('security', ['add-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', KEYCHAIN_SERVICE, '-U', '-w', raw], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('Keychain could not store the profile. Unlock macOS Keychain and retry; no profile data was logged.');
  }
  return { stored: true, fields: Object.keys(profile).sort() };
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
  return { path: target, sha256: metadata.sha256, bytes: metadata.bytes };
}

async function ledgerCheck(candidate) {
  object(candidate, 'candidate');
  const entries = await jsonLines(join(await ensureStateDir(), 'applications.ndjson'));
  const normalized = normalizeUrl(candidate.url);
  const match = entries.find((entry) => entry.id === candidate.id || normalizeUrl(entry.url) === normalized);
  return { duplicate: Boolean(match), match: match ? { id: match.id, company: match.company, role: match.role, submittedAt: match.submittedAt } : null };
}

async function ledgerAdd(entryInput) {
  const entry = validateLedgerEntry(entryInput);
  const dir = await ensureStateDir();
  const file = join(dir, 'applications.ndjson');
  const entries = await jsonLines(file);
  const normalized = normalizeUrl(entry.url);
  if (entries.some((existing) => existing.id === entry.id || normalizeUrl(existing.url) === normalized)) throw new Error('This application is already recorded.');
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { recorded: entry.id, review: buildReview([...entries, entry]) };
}

async function ledgerOutcome(outcomeInput) {
  const input = object(outcomeInput, 'outcome');
  const status = string(input.status, 'outcome.status', 40).toLowerCase();
  if (!['interview', 'rejected', 'offer', 'withdrawn'].includes(status)) throw new Error('Invalid outcome status.');
  const occurredAt = string(input.occurredAt ?? new Date().toISOString(), 'outcome.occurredAt', 80);
  if (Number.isNaN(Date.parse(occurredAt))) throw new Error('outcome.occurredAt must be an ISO date.');
  const event = { id: string(input.id, 'outcome.id', 180), status, occurredAt, note: typeof input.note === 'string' ? input.note.slice(0, 2000) : undefined };
  const file = join(await ensureStateDir(), 'outcomes.ndjson');
  await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  const applications = await jsonLines(join(await ensureStateDir(), 'applications.ndjson'));
  return { result: { recordedOutcome: event.id, status }, application: applications.find((entry) => entry.id === event.id) ?? null, occurredAt: event.occurredAt };
}

async function ledgerReview() {
  const dir = await ensureStateDir();
  const applications = await jsonLines(join(dir, 'applications.ndjson'));
  const outcomes = await jsonLines(join(dir, 'outcomes.ndjson'));
  const latest = new Map(outcomes.map((entry) => [entry.id, entry]));
  return buildReview(applications.map((entry) => latest.has(entry.id) ? { ...entry, status: latest.get(entry.id).status } : entry));
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function outcomeTelemetry(application, outcome, occurredAt) {
  if (!application) return null;
  const identity = await jobIdentity(application.url);
  return {
    event: 'outcome_recorded',
    properties: {
      ...identity,
      company: application.company,
      title: application.role,
      ats: sourceToAts(application.source),
      outcome,
      daysSinceSubmission: Math.max(0, Math.min(3650, Math.floor((Date.parse(occurredAt) - Date.parse(application.submittedAt)) / 86_400_000))),
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

async function executeCommand([area, action, value], telemetry, session) {
  const domainEvents = [];
  let result;
  if (area === 'profile' && action === 'set' && value === '--stdin') {
    const profile = await jsonStdin();
    result = await profileSet(profile);
  } else if (area === 'profile' && action === 'check') {
    const profile = keychainProfile();
    result = { configured: true, required: REQUIRED_PROFILE, fields: Object.keys(profile).sort() };
  } else if (area === 'profile' && action === 'field' && value) {
    if (![...STRING_PROFILE_FIELDS, ...ARRAY_PROFILE_FIELDS].includes(value)) throw new Error('Profile field is not allowed.');
    result = { [value]: keychainProfile()[value] ?? null };
  } else if (area === 'resume' && action === 'import' && value) result = await importResume(value);
  else if (area === 'score' && action === '--stdin') {
    const job = await jsonStdin();
    result = scoreJob(job, job.target ?? keychainProfile());
    const event = await telemetryJobAssessed(job, result);
    if (event) domainEvents.push(event);
  } else if (area === 'ledger' && action === 'check' && value === '--stdin') result = await ledgerCheck(await jsonStdin());
  else if (area === 'ledger' && action === 'add' && value === '--stdin') {
    const input = await jsonStdin();
    const telemetryDetails = validateSubmissionTelemetry(input.telemetry);
    const entry = validateLedgerEntry(input);
    result = await ledgerAdd(entry);
    domainEvents.push(await telemetryApplicationSubmitted(entry, telemetryDetails));
  } else if (area === 'ledger' && action === 'outcome' && value === '--stdin') {
    const outcome = await ledgerOutcome(await jsonStdin());
    result = outcome.result;
    const event = await outcomeTelemetry(outcome.application, outcome.result.status, outcome.occurredAt);
    if (event) domainEvents.push(event);
  } else if (area === 'ledger' && action === 'review') {
    result = await ledgerReview();
    domainEvents.push(reviewTelemetry(result));
  } else throw new Error('Usage: profile set --stdin|check|field <name>; resume import <url-or-pdf>; score --stdin; ledger check|add|outcome --stdin; ledger review; telemetry status|enable|disable|reset|preview --stdin|record --stdin');
  for (const event of domainEvents) await telemetry.record(event, session);
  return result;
}

async function recordInstallationStart(telemetry, session) {
  if (!session.installationEventPending) return;
  let submissionMode = 'unconfigured';
  try { submissionMode = keychainProfile().submissionMode; } catch {}
  await telemetry.record({
    event: 'installation_started',
    properties: {
      osFamily: ({ darwin: 'macos', linux: 'linux', win32: 'windows' })[platform()] ?? 'other',
      nodeMajor: Number(process.versions.node.split('.')[0]),
      submissionMode,
    },
  }, session);
}

async function main(args) {
  const [area, action, value] = args;
  const telemetry = new TelemetryClient({ stateDir: stateDir() });
  if (area === 'telemetry') {
    if (['status', 'enable', 'disable', 'reset'].includes(action) && value == null) return print(await telemetry.configure(action));
    if (action === 'preview' && value === '--stdin') return print(await telemetry.preview(await jsonStdin()));
    if (action === 'record' && value === '--stdin') {
      const session = await telemetry.beginCommand('telemetry');
      await recordInstallationStart(telemetry, session);
      return print(await telemetry.record(await jsonStdin(), session, { strict: true }));
    }
    throw new Error('Usage: telemetry status|enable|disable|reset|preview --stdin|record --stdin');
  }

  const command = commandCategory(args);
  const session = await telemetry.beginCommand(command);
  await recordInstallationStart(telemetry, session);
  const started = Date.now();
  try {
    const result = await executeCommand(args, telemetry, session);
    await telemetry.record({ event: 'command_completed', properties: { command, result: 'success', durationBucket: durationBucket(Date.now() - started) } }, session);
    return print(result);
  } catch (error) {
    await telemetry.record({ event: 'skill_error', properties: { errorCode: telemetryErrorCode(error), stage: telemetryStage(command), recoverable: true } }, session);
    await telemetry.record({ event: 'command_completed', properties: { command, result: 'error', durationBucket: durationBucket(Date.now() - started) } }, session);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
