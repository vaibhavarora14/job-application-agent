// Guided first-job activation for a fresh install. Shown after `install` and on
// `status` until a local score record exists. Resume-import recovery tells the
// agent how to retry; it never includes a file name, company name, or résumé text.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { JOBS_BOARD_URL, firstJobPrompt } from './managed-runtime.mjs';
import { ASSESSMENT_DECISIONS_FILE } from './routine-gates.mjs';
import { resolveStateDir } from './secret-store.mjs';

export const RESUME_PDF_FILE = 'resume.pdf';
export const MIN_PASTED_RESUME_CHARS = 40;
export const MAX_PASTED_RESUME_CHARS = 500_000;

export const RESUME_IMPORT_COMMAND = 'node scripts/job-application.mjs resume import <google-doc-url-or-local-pdf>';
export const RESUME_IMPORT_STDIN_COMMAND = 'node scripts/job-application.mjs resume import --stdin';

export const RESUME_IMPORT_RECOVERY = [
  'Ask the candidate for a résumé, then retry. Do not skip this step and do not invent a résumé.',
  '1. Local PDF: run resume import with an absolute path to a .pdf file (relative paths and .docx/.txt files are refused).',
  '2. Google Docs: paste a shareable https://docs.google.com/document/d/... URL (anyone-with-the-link or public so PDF export works) and run resume import with that URL.',
  `3. Paste: have the candidate paste the résumé text in chat, then pipe {"text":"<pasted résumé>"} to ${RESUME_IMPORT_STDIN_COMMAND}.`,
  'Then retry the same command.',
].join(' ');

export function resumeImportFailure(message) {
  const prefix = String(message ?? '').trim() || 'Résumé import failed.';
  return Object.assign(new Error(`${prefix} ${RESUME_IMPORT_RECOVERY}`), { telemetryErrorCode: 'upload_failed' });
}

function jobsObject(state) {
  const jobs = state?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return null;
  return jobs;
}

export function hasAssessedJob(state) {
  const jobs = jobsObject(state);
  return jobs != null && Object.keys(jobs).length > 0;
}

async function readJsonObject(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

async function resumeFilePresent(dir) {
  try {
    const details = await stat(join(dir, RESUME_PDF_FILE));
    return details.isFile() && details.size > 0;
  } catch {
    return false;
  }
}

export async function activationSnapshot({ env = process.env, homeDir } = {}) {
  const dir = resolveStateDir({ env, home: homeDir });
  const decisions = await readJsonObject(join(dir, ASSESSMENT_DECISIONS_FILE));
  return {
    assessed: hasAssessedJob(decisions),
    resumeImported: await resumeFilePresent(dir),
  };
}

export function firstJobReason(previousSkillVersion, currentVersion) {
  if (typeof previousSkillVersion !== 'string' || !previousSkillVersion) return 'install';
  return previousSkillVersion === currentVersion ? 'pending' : 'upgrade';
}

export function firstJobGuide(currentVersion, previousSkillVersion, {
  resumeImported = false,
  assessed = false,
} = {}) {
  if (assessed) return null;
  const prompt = firstJobPrompt(currentVersion, previousSkillVersion);
  const reason = firstJobReason(previousSkillVersion, currentVersion);
  const resumeStep = resumeImported
    ? 'A résumé is already imported.'
    : `No résumé is imported yet. ${RESUME_IMPORT_RECOVERY}`;
  return {
    ...prompt,
    reason,
    assessed: false,
    resumeImported: resumeImported === true,
    resumeRecovery: resumeImported === true ? undefined : RESUME_IMPORT_RECOVERY,
    instruction: `${resumeStep} Ask the candidate to pick one live role at ${JOBS_BOARD_URL} or paste one employer application URL. Run that one job in review-each: open the posting, run score --stdin with its full text, fill the employer page, and stop before Submit. Record it only after they confirm visible success. Do not auto-submit. Do not invent fill counts.`,
  };
}

export function formatFirstJobGuide(guide, { heading = 'Next: complete one first job in review-each.' } = {}) {
  if (!guide) return '';
  const resumeLines = guide.resumeImported
    ? ['A résumé is already imported.']
    : [
      'No résumé is imported yet. Ask the candidate for one, then retry:',
      `  ${RESUME_IMPORT_COMMAND}`,
      `  echo '{"text":"<pasted résumé>"}' | ${RESUME_IMPORT_STDIN_COMMAND}`,
      'Use an absolute PDF path, a shareable Google Docs URL, or pasted text. Do not skip this and do not invent a résumé.',
    ];
  return [
    heading,
    ...resumeLines,
    `Pick one live role at ${JOBS_BOARD_URL} or paste one employer application URL.`,
    'Run that one job in review-each. Record it only after they confirm visible success.',
    'Do not auto-submit. Do not invent fill counts.',
  ].join('\n');
}

function jsonSourceKind(value) {
  if (typeof value.text === 'string') return { kind: 'text', text: value.text };
  if (typeof value.path === 'string') return { kind: 'path', source: value.path };
  if (typeof value.url === 'string') return { kind: 'url', source: value.url };
  if (typeof value.source === 'string') {
    if (/^https:\/\//i.test(value.source)) return { kind: 'url', source: value.source };
    return { kind: 'path', source: value.source };
  }
  return { kind: 'invalid-json' };
}

export function parseResumeImportInput(raw, { inlineJson } = {}) {
  if (inlineJson !== undefined) {
    if (inlineJson && typeof inlineJson === 'object' && !Array.isArray(inlineJson)) return jsonSourceKind(inlineJson);
    return { kind: 'invalid-json' };
  }
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ''), 'utf8');
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from('%PDF'))) {
    return { kind: 'pdf-bytes', bytes: buffer };
  }
  const text = buffer.toString('utf8');
  const trimmed = text.trim();
  if (!trimmed) return { kind: 'empty' };
  if (trimmed.startsWith('%PDF')) return { kind: 'pdf-bytes', bytes: buffer };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return jsonSourceKind(parsed);
      return { kind: 'invalid-json' };
    } catch {
      return { kind: 'text', text: trimmed };
    }
  }
  if (/^https:\/\/docs\.google\.com\/document\/d\//i.test(trimmed) && !trimmed.includes('\n')) {
    return { kind: 'url', source: trimmed };
  }
  if (/\.pdf$/i.test(trimmed) && !trimmed.includes('\n')) return { kind: 'path', source: trimmed };
  return { kind: 'text', text: trimmed };
}

export function assertPastedResumeText(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) throw resumeImportFailure('Pasted résumé text was empty.');
  if (value.length < MIN_PASTED_RESUME_CHARS) {
    throw resumeImportFailure(`Pasted résumé text is too short (need at least ${MIN_PASTED_RESUME_CHARS} characters).`);
  }
  if (value.length > MAX_PASTED_RESUME_CHARS) {
    throw resumeImportFailure('Pasted résumé text is too long.');
  }
  return value;
}
