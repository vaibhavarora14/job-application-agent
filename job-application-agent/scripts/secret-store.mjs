// child_process runs only the OS credential-store tools, each with a fixed binary and an
// argument array (never a shell): macOS `security`, Linux `secret-tool`, and on Windows
// `powershell.exe -File` on this package's own windows-profile-store.ps1. The profile
// goes over stdin, never on the command line, and nothing is sent over the network.
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROFILE_ACCOUNT = 'profile';
export const DEFAULT_SECRET_SERVICE = 'com.vaibhavarora.job-application-agent';
export const LEGACY_SECRET_SERVICE = 'com.openai.codex.job-application-agent';
export const UNSUPPORTED_PLATFORM_ERROR = 'Secure profile storage is not supported on this platform.';
export const LINUX_STORE_REQUIRED_TOOL = 'secret-tool';
export const LINUX_SECRET_MAX_BYTES = 8191;
export const WINDOWS_PROFILE_SCRIPT = fileURLToPath(new URL('./windows-profile-store.ps1', import.meta.url));
export const PROFILE_MISSING_MESSAGE = 'The stored profile is missing or unreadable. Run profile set again.';

// Nothing is stored yet (a first run), as opposed to a read that failed. `profile check` reports this
// as "not configured" instead of failing (#240); every other caller still sees the same error text.
export function profileMissingError() {
  return Object.assign(new Error(PROFILE_MISSING_MESSAGE), { code: 'PROFILE_MISSING' });
}
export const isProfileMissingError = (error) => error?.code === 'PROFILE_MISSING';

export function resolveSecretService(env = process.env) {
  return env.JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE || DEFAULT_SECRET_SERVICE;
}

export function resolveStateDir({
  env = process.env,
  home = homedir(),
  plat = process.platform,
} = {}) {
  if (env.JOB_APPLICATION_AGENT_STATE_DIR) return env.JOB_APPLICATION_AGENT_STATE_DIR;
  if (plat === 'win32') {
    const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
    return join(appData, 'job-application-agent');
  }
  if (plat === 'darwin') return join(home, 'Library', 'Application Support', 'job-application-agent');
  return join(home, '.local', 'share', 'job-application-agent');
}

export function legacyMacStateDir(home = homedir()) {
  return join(home, 'Library', 'Application Support', 'Codex', 'job-application-agent');
}

async function exists(filePath) {
  try { await lstat(filePath); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function migrateLegacyStateDir(dir, {
  env = process.env,
  home = homedir(),
  plat = process.platform,
} = {}) {
  if (env.JOB_APPLICATION_AGENT_STATE_DIR) return false;
  if (plat !== 'darwin') return false;
  const legacy = legacyMacStateDir(home);
  if (resolve(dir) === resolve(legacy)) return false;
  if (!(await exists(legacy))) return false;
  if (await exists(dir)) return false;
  await mkdir(resolve(dir, '..'), { recursive: true });
  await cp(legacy, dir, { recursive: true });
  return true;
}

function decodeSecret(value) {
  const trimmed = String(value ?? '').trim();
  return /^[0-9a-f]+$/i.test(trimmed) && trimmed.length % 2 === 0 ? Buffer.from(trimmed, 'hex').toString('utf8') : trimmed;
}

// `security` exits 44 (errSecItemNotFound) when there is no such item. Any other failure (a locked
// or inaccessible Keychain) is still read as "no item" here, as before, but is not reported as a
// first run: only a confirmed not-found may make `profile check` say "nothing stored yet".
const DARWIN_ITEM_NOT_FOUND = 44;
const darwinNotFound = (error) => error?.status === DARWIN_ITEM_NOT_FOUND || /could not be found in the keychain/i.test(String(error?.stderr ?? ''));

function darwinFind(exec, service, account, misses) {
  try {
    return exec('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (!darwinNotFound(error)) misses.unconfirmed = true;
    return null;
  }
}

function darwinWrite(exec, service, account, raw) {
  try {
    exec('security', ['add-generic-password', '-a', account, '-s', service, '-U', '-w', raw], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('Keychain could not store the profile. Unlock macOS Keychain and retry; no profile data was logged.');
  }
}

function createDarwinStore({ execFileSync: exec, service, legacyService, account }) {
  return {
    readProfile() {
      const misses = { unconfirmed: false };
      const current = darwinFind(exec, service, account, misses);
      if (current != null) return decodeSecret(current);
      if (legacyService && legacyService !== service) {
        const legacy = darwinFind(exec, legacyService, account, misses);
        if (legacy != null) {
          const raw = decodeSecret(legacy);
          darwinWrite(exec, service, account, raw);
          return raw;
        }
      }
      throw misses.unconfirmed ? new Error(PROFILE_MISSING_MESSAGE) : profileMissingError();
    },
    writeProfile(raw) {
      darwinWrite(exec, service, account, raw);
    },
  };
}

function linuxToolMissing(error) {
  return error?.code === 'ENOENT';
}

function linuxFind(exec, service, account) {
  try {
    return exec(LINUX_STORE_REQUIRED_TOOL, ['lookup', 'service', service, 'account', account], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (linuxToolMissing(error)) throw new Error(`${LINUX_STORE_REQUIRED_TOOL} is not installed. Install libsecret-tools (e.g. sudo apt-get install libsecret-tools) to enable Linux profile storage.`);
    if (String(error?.stderr ?? '').trim()) {
      throw new Error('Secret Service could not read the profile. Start or unlock your keyring and retry; no profile data was logged.');
    }
    return null;
  }
}

function linuxWrite(exec, service, account, raw) {
  if (Buffer.byteLength(raw, 'utf8') > LINUX_SECRET_MAX_BYTES) {
    throw new Error(`The profile is too large for Linux Secret Service storage. Keep it under ${LINUX_SECRET_MAX_BYTES + 1} UTF-8 bytes and retry; the stored profile was not changed.`);
  }
  try {
    exec(LINUX_STORE_REQUIRED_TOOL, ['store', '--label=job-application-agent', 'service', service, 'account', account], {
      input: raw,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (linuxToolMissing(error)) throw new Error(`${LINUX_STORE_REQUIRED_TOOL} is not installed. Install libsecret-tools (e.g. sudo apt-get install libsecret-tools) to enable Linux profile storage.`);
    throw new Error('Secret Service could not store the profile. Unlock your keyring and retry; no profile data was logged.');
  }
}

function createLinuxStore({ execFileSync: exec, service, account }) {
  return {
    readProfile() {
      const current = linuxFind(exec, service, account);
      if (current != null && current.trim()) return decodeSecret(current.trim());
      throw profileMissingError();
    },
    writeProfile(raw) {
      linuxWrite(exec, service, account, raw);
    },
  };
}

// The Windows helper only accepts the fixed service name or a dotted sub-name of it
// (tests use `<service>.test-…`); windows-profile-store.ps1 enforces the same rule.
export function isAllowedWindowsService(service) {
  return typeof service === 'string'
    && /^[A-Za-z0-9._-]{1,200}$/.test(service)
    && (service === DEFAULT_SECRET_SERVICE || service.startsWith(`${DEFAULT_SECRET_SERVICE}.`));
}

function windowsRequest(exec, scriptPath, payload, plaintext = '') {
  if (!isAllowedWindowsService(payload.service)) {
    throw new Error(`Windows profile storage only uses the ${DEFAULT_SECRET_SERVICE} service name (or ${DEFAULT_SECRET_SERVICE}.<suffix>). Unset or fix JOB_APPLICATION_AGENT_KEYCHAIN_SERVICE and retry.`);
  }
  const input = `${JSON.stringify(payload)}\n${plaintext}`;
  try {
    // Why `-ExecutionPolicy Bypass` stays: Windows 10/11 ship with the
    // `Restricted` client policy, under which no .ps1 file runs at all, so
    // `-File` without it fails on a default machine. The override applies to
    // this one child process only; it never changes the machine or user policy.
    // The alternatives are worse. `-EncodedCommand` hides the script from
    // review and AV/AMSI heuristics. `-Command` with the script inline (or `-Command -`
    // from stdin) breaks on Windows PowerShell 5.1 quoting and multi-line block
    // parsing, and stdin already carries the request. Moving the plaintext to an
    // environment variable would expose it to same-user processes. Authenticode
    // signing would help only under AllSigned and needs a code-signing
    // certificate the project does not have. The script is a fixed file shipped
    // in the package (never user-supplied), and it validates every request.
    return exec('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File',
      scriptPath,
    ], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const rejected = /Windows profile storage rejected the request: ([a-z .-]+)\./.exec(String(error?.stderr ?? ''));
    if (rejected) throw new Error(`Windows profile storage rejected the request: ${rejected[1]}. No profile data was logged.`);
    throw windowsStorageError(error);
  }
}

// windows-profile-store.ps1 reports which step failed as a fixed class (#228). Map it to a message
// with the right next step and an existing telemetry error code; only Credential Manager failures
// are `authentication_required`. Paths, profile data and exception messages never reach here.
const WINDOWS_FAILURE = /Windows profile storage failed: ([a-z-]{1,40})(?: \(([A-Za-z0-9_.; ]{1,160})\))?\./;
const WINDOWS_STAGE_HINTS = Object.freeze({
  'credential-read': ['authentication_required', 'Windows Credential Manager could not read the profile key. Sign in to Windows interactively (not over SSH, a service or a scheduled task), unlock Credential Manager and retry'],
  'credential-write': ['authentication_required', 'Windows Credential Manager refused to store the profile key. Sign in to Windows interactively (not over SSH, a service or a scheduled task), unlock Credential Manager and retry'],
  'add-type': ['internal_error', 'PowerShell blocked the profile helper (Constrained Language Mode, AppLocker/WDAC or antivirus). Allow the job-application-agent profile helper or run from a standard PowerShell session, then retry'],
  dpapi: ['internal_error', 'Windows data protection (DPAPI) could not seal or open the profile for this Windows account. Retry from the same signed-in Windows user'],
  'file-write': ['internal_error', 'The profile file could not be written to the job-application-agent state folder. Check that the folder is writable and not blocked by OneDrive or antivirus, then retry'],
  'file-read': ['internal_error', 'The profile file in the job-application-agent state folder could not be read. Check the folder is available (OneDrive files on demand, antivirus), then retry'],
  'path-check': ['internal_error', 'The job-application-agent state folder could not be checked. If it is redirected (OneDrive, a network share or a link), set JOB_APPLICATION_AGENT_STATE_DIR to a local folder and retry'],
  encrypt: ['internal_error', 'The profile could not be encrypted. Retry'],
  decrypt: ['internal_error', 'The stored profile could not be decrypted with the current key. Run profile set again'],
  request: ['internal_error', 'The profile helper could not read its request. Retry'],
});

function windowsStorageError(error) {
  if (error?.code === 'ENOENT') {
    return Object.assign(new Error('Windows profile storage failed: powershell.exe was not found. Windows PowerShell is required to store the profile; no profile data was logged.'), { telemetryErrorCode: 'internal_error' });
  }
  const match = WINDOWS_FAILURE.exec(String(error?.stderr ?? ''));
  const stage = match?.[1];
  if (stage === 'missing') return profileMissingError();
  const hint = WINDOWS_STAGE_HINTS[stage];
  if (!hint) {
    // An older helper, or PowerShell failed before the helper's own error handling ran.
    return Object.assign(new Error('Windows profile storage failed (unknown step). Retry; if it keeps failing, report the PowerShell version. No profile data was logged.'), { telemetryErrorCode: 'internal_error' });
  }
  const detail = match[2] ? `, ${match[2]}` : '';
  return Object.assign(new Error(`Windows profile storage failed (${stage}${detail}). ${hint}; no profile data was logged.`), { telemetryErrorCode: hint[0] });
}

function createWin32Store({
  execFileSync: exec,
  service,
  account,
  stateDir,
  scriptPath = WINDOWS_PROFILE_SCRIPT,
}) {
  const profilePath = () => join(typeof stateDir === 'function' ? stateDir() : stateDir, 'profile.dat');
  return {
    readProfile() {
      const raw = windowsRequest(exec, scriptPath, { op: 'get', service, account, path: profilePath() });
      const text = String(raw ?? '').replace(/^\uFEFF/, '');
      if (!text.trim()) throw profileMissingError();
      return text;
    },
    writeProfile(raw) {
      windowsRequest(exec, scriptPath, { op: 'set', service, account, path: profilePath() }, raw);
    },
  };
}

function unsupportedStore() {
  return {
    readProfile() { throw new Error(UNSUPPORTED_PLATFORM_ERROR); },
    writeProfile() { throw new Error(UNSUPPORTED_PLATFORM_ERROR); },
  };
}

export function createSecretStore({
  platform = process.platform,
  env = process.env,
  execFileSync: exec = execFileSync,
  service = resolveSecretService(env),
  legacyService = LEGACY_SECRET_SERVICE,
  account = PROFILE_ACCOUNT,
  stateDir = () => resolveStateDir({ env, plat: platform }),
  scriptPath = WINDOWS_PROFILE_SCRIPT,
} = {}) {
  if (platform === 'darwin') return createDarwinStore({ execFileSync: exec, service, legacyService, account });
  if (platform === 'win32') return createWin32Store({ execFileSync: exec, service, account, stateDir, scriptPath });
  if (platform === 'linux') return createLinuxStore({ execFileSync: exec, service, account });
  return unsupportedStore();
}
