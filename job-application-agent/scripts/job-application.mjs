#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const KEYCHAIN_SERVICE = process.env.JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE ?? 'com.openai.codex.job-application-agent';
const KEYCHAIN_ACCOUNT = 'profile';
const DEFAULT_STATE_DIR = join(homedir(), 'Library/Application Support/Codex/job-application-agent');
const SOURCES = new Set(['linkedin', 'greenhouse', 'lever', 'ashby', 'workable', 'company', 'email', 'other']);
const ELIGIBILITY = new Set(['eligible', 'unclear', 'ineligible']);
const APPROVALS = new Set(['APPROVE SUBMIT', 'STANDING AUTHORIZATION']);
const MODES = new Set(['review-each', 'routine-auto']);
const REQUIRED_PROFILE = ['name', 'email', 'phone', 'location', 'workAuthorization', 'roleFamilies', 'seniority', 'targetLocations', 'workModes', 'submissionMode'];
const STRING_PROFILE_FIELDS = new Set(['name', 'email', 'phone', 'location', 'workAuthorization', 'linkedin', 'github', 'portfolio', 'availability', 'currentCompensation', 'targetCompensation', 'submissionMode']);
const ARRAY_PROFILE_FIELDS = new Set(['roleFamilies', 'seniority', 'skills', 'targetLocations', 'excludedLocations', 'workModes', 'industries', 'excludedCompanies']);

function stateDir() {
  return process.env.JOB_APPLICATION_AGENT_STATE_DIR || DEFAULT_STATE_DIR;
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

export function buildReview(entries) {
  const submissions = entries.filter((entry) => entry.status === 'submitted' && !Number.isNaN(Date.parse(entry.submittedAt)));
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

async function profileSet() {
  if (process.platform !== 'darwin') throw new Error('Secure profile storage currently requires macOS Keychain.');
  const profile = validateProfile(await jsonStdin());
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

async function ledgerAdd() {
  const entry = validateLedgerEntry(await jsonStdin());
  const dir = await ensureStateDir();
  const file = join(dir, 'applications.ndjson');
  const entries = await jsonLines(file);
  const normalized = normalizeUrl(entry.url);
  if (entries.some((existing) => existing.id === entry.id || normalizeUrl(existing.url) === normalized)) throw new Error('This application is already recorded.');
  await appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { recorded: entry.id, review: buildReview([...entries, entry]) };
}

async function ledgerOutcome() {
  const input = object(await jsonStdin(), 'outcome');
  const status = string(input.status, 'outcome.status', 40).toLowerCase();
  if (!['interview', 'rejected', 'offer', 'withdrawn'].includes(status)) throw new Error('Invalid outcome status.');
  const event = { id: string(input.id, 'outcome.id', 180), status, occurredAt: input.occurredAt ?? new Date().toISOString(), note: typeof input.note === 'string' ? input.note.slice(0, 2000) : undefined };
  const file = join(await ensureStateDir(), 'outcomes.ndjson');
  await appendFile(file, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { recordedOutcome: event.id, status };
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

async function main([area, action, value]) {
  if (area === 'profile' && action === 'set' && value === '--stdin') return print(await profileSet());
  if (area === 'profile' && action === 'check') {
    const profile = keychainProfile();
    return print({ configured: true, required: REQUIRED_PROFILE, fields: Object.keys(profile).sort() });
  }
  if (area === 'profile' && action === 'field' && value) {
    if (![...STRING_PROFILE_FIELDS, ...ARRAY_PROFILE_FIELDS].includes(value)) throw new Error('Profile field is not allowed.');
    return print({ [value]: keychainProfile()[value] ?? null });
  }
  if (area === 'resume' && action === 'import' && value) return print(await importResume(value));
  if (area === 'score' && action === '--stdin') {
    const job = await jsonStdin();
    return print(scoreJob(job, job.target ?? keychainProfile()));
  }
  if (area === 'ledger' && action === 'check' && value === '--stdin') return print(await ledgerCheck(await jsonStdin()));
  if (area === 'ledger' && action === 'add' && value === '--stdin') return print(await ledgerAdd());
  if (area === 'ledger' && action === 'outcome' && value === '--stdin') return print(await ledgerOutcome());
  if (area === 'ledger' && action === 'review') return print(await ledgerReview());
  throw new Error('Usage: profile set --stdin|check|field <name>; resume import <url-or-pdf>; score --stdin; ledger check|add|outcome --stdin; ledger review');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
