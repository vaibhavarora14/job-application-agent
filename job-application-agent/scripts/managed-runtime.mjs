// Skill-only installs (npx skills add, ClawHub, or a copied skill directory) ship the
// skill folder without the managed npm installer. Assess and apply stay refused until
// `npx job-application-agent@latest install` has written install.json. A managed install
// or a later skillVersion upgrade prompts one review-each job and does not auto-submit.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const INSTALL_COMMAND = 'npx job-application-agent@latest install';
export const JOBS_BOARD_URL = 'https://jobappagent.com/jobs';
export const FIRST_JOB_PROMPTED_VERSION = 'firstJobPromptedVersion';

export const MANAGED_RUNTIME_REFUSAL = `The managed runtime must be installed before assess or apply. This copy is a skills-registry, ClawHub, or copied skill directory and has no managed install. Run \`${INSTALL_COMMAND}\` on the same machine as the browser, then retry.`;

export function managedInstallConfigPath(env = process.env, homeDir = homedir()) {
  const agentHome = env.JOB_APPLICATION_AGENT_HOME || join(homeDir, '.agents');
  return join(agentHome, 'job-application-agent', 'install.json');
}

/**
 * The managed package (repo checkout or npm tarball) keeps installer/src/cli.mjs beside
 * the skill folder. A copied skill directory is the skill folder alone.
 */
export function isCopiedSkillDirectory(scriptFile, existsImpl = existsSync) {
  if (typeof scriptFile !== 'string' || !scriptFile) return false;
  const packageRoot = dirname(dirname(dirname(scriptFile)));
  return !(existsImpl(join(packageRoot, 'package.json')) && existsImpl(join(packageRoot, 'installer', 'src', 'cli.mjs')));
}

export function readManagedInstallSync(env = process.env, homeDir = homedir()) {
  try {
    const value = JSON.parse(readFileSync(managedInstallConfigPath(env, homeDir), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Refusal text when assess/apply must stop, or null when the command may proceed. */
export function assessApplyRefusal({ scriptFile, env = process.env, existsImpl = existsSync, homeDir = homedir() } = {}) {
  if (!isCopiedSkillDirectory(scriptFile, existsImpl)) return null;
  const config = readManagedInstallSync(env, homeDir);
  if (config?.installed === true) return null;
  return MANAGED_RUNTIME_REFUSAL;
}

export function firstJobPrompt(currentVersion, previousSkillVersion) {
  const previous = typeof previousSkillVersion === 'string' ? previousSkillVersion : null;
  return {
    reason: previous ? 'upgrade' : 'install',
    previousSkillVersion: previous,
    skillVersion: currentVersion,
    mode: 'review-each',
    autoSubmit: false,
    recordOnlyConfirmed: true,
    jobsUrl: JOBS_BOARD_URL,
    instruction: `Ask the candidate to pick one live role at ${JOBS_BOARD_URL} or paste one employer application URL. Run that one job in review-each. Record it only after they confirm visible success. Do not auto-submit. Do not invent fill counts.`,
  };
}

export function managedRuntimeStatus() {
  return {
    installed: false,
    command: INSTALL_COMMAND,
    instruction: MANAGED_RUNTIME_REFUSAL,
  };
}
