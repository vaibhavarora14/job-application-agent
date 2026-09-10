import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { scoreJob, validateLedgerEntry, validateProfile, profileStatus } from '../../job-application-agent/scripts/job-application.mjs';
import { createSecretStore, resolveStateDir } from '../../job-application-agent/scripts/secret-store.mjs';
import { nowIso, openDb } from './db.mjs';
import { SKILL_CLI, ensureDataDirs, skillStateDir } from './paths.mjs';

export { scoreJob, validateLedgerEntry, validateProfile, profileStatus };

export function extrasFromBody(body = {}) {
  return {
    motivationBlurb: body.motivationBlurb ?? body.motivation_blurb ?? '',
    howHeard: body.howHeard ?? body.how_heard ?? 'company careers page',
    authorizedWithoutSponsorship: body.authorizedWithoutSponsorship ?? body.authorized_without_sponsorship ?? 'unclear',
    needsSponsorship: body.needsSponsorship ?? body.needs_sponsorship ?? 'unclear',
    willingToRelocate: body.willingToRelocate ?? body.willing_to_relocate ?? 'unclear',
  };
}

export function saveProfile(profileInput, extras = {}, resumePath = null, env = process.env) {
  const profile = validateProfile(profileInput);
  const db = openDb(env);
  db.prepare(`INSERT INTO profile (id, json, motivation_blurb, how_heard, authorized_without_sponsorship, needs_sponsorship, willing_to_relocate, resume_path, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      json = excluded.json,
      motivation_blurb = excluded.motivation_blurb,
      how_heard = excluded.how_heard,
      authorized_without_sponsorship = excluded.authorized_without_sponsorship,
      needs_sponsorship = excluded.needs_sponsorship,
      willing_to_relocate = excluded.willing_to_relocate,
      resume_path = COALESCE(excluded.resume_path, profile.resume_path),
      updated_at = excluded.updated_at`)
    .run(
      JSON.stringify(profile),
      extras.motivationBlurb ?? '',
      extras.howHeard ?? '',
      extras.authorizedWithoutSponsorship ?? 'unclear',
      extras.needsSponsorship ?? 'unclear',
      extras.willingToRelocate ?? 'unclear',
      resumePath,
      nowIso(),
    );
  return getProfile(env);
}

export function getProfile(env = process.env) {
  const row = openDb(env).prepare('SELECT * FROM profile WHERE id = 1').get();
  if (!row) return { configured: false, missing: ['profile'], profile: null, extras: {} };
  const profile = JSON.parse(row.json);
  const status = profileStatus(profile);
  return {
    ...status,
    profile,
    extras: {
      motivationBlurb: row.motivation_blurb,
      howHeard: row.how_heard,
      authorizedWithoutSponsorship: row.authorized_without_sponsorship,
      needsSponsorship: row.needs_sponsorship,
      willingToRelocate: row.willing_to_relocate,
    },
    resumePath: row.resume_path,
  };
}

export async function storeResume(sourcePath, env = process.env) {
  ensureDataDirs(env);
  const dest = join(skillStateDir(env), 'resume.pdf');
  await mkdir(skillStateDir(env), { recursive: true, mode: 0o700 });
  await copyFile(sourcePath, dest);
  const db = openDb(env);
  db.prepare('UPDATE profile SET resume_path = ?, updated_at = ? WHERE id = 1').run(dest, nowIso());
  try {
    await runSkill(['resume', 'import', dest], null, env);
  } catch {
    // Headless boxes may lack a keyring; the copied PDF is enough for Playwright.
  }
  return dest;
}

export function hostSkillEnv(env = process.env) {
  const host = { ...env };
  delete host.JOB_APPLICATION_AGENT_STATE_DIR;
  delete host.CLOUD_DATA_DIR;
  delete host.CLOUD_DB_PATH;
  return host;
}

export async function importLocalCandidate({
  profile,
  resumePath = null,
  extras = {},
  env = process.env,
} = {}) {
  if (!profile) throw new Error('No profile to import.');
  const saved = saveProfile(profile, extrasFromBody({ ...profile, ...extras }), null, env);
  let copiedResume = null;
  if (resumePath && existsSync(resumePath)) copiedResume = await storeResume(resumePath, env);
  return { ...saved, resumePath: copiedResume || saved.resumePath, imported: true };
}

export async function importFromLocalSkill(env = process.env, {
  readProfile = null,
  resumePath = null,
} = {}) {
  const host = hostSkillEnv(env);
  let profile;
  try {
    const raw = readProfile
      ? readProfile()
      : createSecretStore({ env: host }).readProfile();
    profile = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (error) {
    throw new Error(`Could not read the laptop skill profile. ${error.message}`);
  }
  const resume = resumePath || join(resolveStateDir({ env: host }), 'resume.pdf');
  return importLocalCandidate({
    profile,
    extras: extrasFromBody(profile),
    resumePath: existsSync(resume) ? resume : null,
    env,
  });
}

export async function runSkill(args, stdinObject = null, env = process.env) {
  ensureDataDirs(env);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SKILL_CLI, ...args], {
      env: { ...env, JOB_APPLICATION_AGENT_STATE_DIR: skillStateDir(env) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `skill exited ${code}`));
        return;
      }
      try { resolve(JSON.parse(stdout)); }
      catch { resolve(stdout.trim() ? { raw: stdout.trim() } : {}); }
    });
    if (stdinObject != null) child.stdin.end(`${JSON.stringify(stdinObject)}\n`);
    else child.stdin.end();
  });
}

export async function ledgerCheck(candidate, env = process.env) {
  try {
    return await runSkill(['ledger', 'check', '--stdin'], candidate, env);
  } catch {
    const db = openDb(env);
    const dup = db.prepare(`SELECT id, status FROM applications WHERE url = ? OR id = ? LIMIT 1`)
      .get(candidate.url, candidate.id);
    return {
      duplicate: Boolean(dup),
      source: 'cloud-db',
      existing: dup ?? null,
    };
  }
}

export async function ledgerAdd(entry, env = process.env) {
  const validated = validateLedgerEntry(entry);
  try {
    return await runSkill(['ledger', 'add', '--stdin'], validated, env);
  } catch (error) {
    return { stored: 'cloud-only', warning: error.message, id: validated.id };
  }
}
