import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSecretStore,
  DEFAULT_SECRET_SERVICE,
  isProfileMissingError,
  LEGACY_SECRET_SERVICE,
  LINUX_AUTH_MARKER,
  LINUX_FALLBACK_KEY,
  LINUX_FALLBACK_PROFILE,
  LINUX_SECRET_MAX_BYTES,
  migrateLegacyStateDir,
  PROFILE_ACCOUNT,
  resolveStateDir,
  UNSUPPORTED_PLATFORM_ERROR,
} from '../scripts/secret-store.mjs';
import { skillErrorProperties } from '../scripts/job-application.mjs';

const sampleProfile = {
  name: 'Test Candidate',
  email: 'candidate@example.com',
  notes: 'keep-me',
};

function darwinExec(store) {
  return (command, args) => {
    assert.equal(command, 'security');
    if (args[0] === 'find-generic-password') {
      const service = args[args.indexOf('-s') + 1];
      const account = args[args.indexOf('-a') + 1];
      const key = `${service}/${account}`;
      if (!store.has(key)) throw new Error('not found');
      return `${store.get(key)}\n`;
    }
    if (args[0] === 'add-generic-password') {
      const account = args[args.indexOf('-a') + 1];
      const service = args[args.indexOf('-s') + 1];
      const value = args[args.indexOf('-w') + 1];
      store.set(`${service}/${account}`, value);
      return '';
    }
    throw new Error(`unexpected security args: ${args.join(' ')}`);
  };
}

function parseWindowsInput(input) {
  const newline = input.indexOf('\n');
  const meta = JSON.parse(newline === -1 ? input : input.slice(0, newline));
  const plaintext = newline === -1 ? '' : input.slice(newline + 1);
  return { meta, plaintext };
}

function windowsExec({ creds, files }) {
  return (command, args, options) => {
    assert.equal(command, 'powershell.exe');
    assert.equal(args.at(-2), '-File');
    const { meta, plaintext } = parseWindowsInput(options.input);
    const credKey = `${meta.service}/${meta.account}`;
    if (meta.op === 'set') {
      if (!creds.has(credKey)) creds.set(credKey, Buffer.alloc(32, 7).toString('base64'));
      assert.ok(Buffer.byteLength(creds.get(credKey), 'utf8') < 2560);
      files.set(meta.path, `DPAPI:${plaintext}`);
      return '';
    }
    if (meta.op === 'get') {
      if (!creds.has(credKey) || !files.has(meta.path)) throw new Error('missing');
      return files.get(meta.path).slice('DPAPI:'.length);
    }
    throw new Error(`unexpected op ${meta.op}`);
  };
}

test('resolves platform state directories off Codex application-support paths', () => {
  assert.equal(
    resolveStateDir({ env: {}, home: '/Users/ada', plat: 'darwin' }),
    join('/Users/ada', 'Library', 'Application Support', 'job-application-agent'),
  );
  assert.equal(
    resolveStateDir({ env: { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, home: 'C:\\Users\\ada', plat: 'win32' }),
    join('C:\\Users\\ada\\AppData\\Roaming', 'job-application-agent'),
  );
  assert.equal(
    resolveStateDir({ env: {}, home: '/home/ada', plat: 'linux' }),
    join('/home/ada', '.local', 'share', 'job-application-agent'),
  );
});

test('copies a legacy Codex macOS state directory when the new path is empty', async () => {
  const home = await mkdtemp(join(tmpdir(), 'job-agent-state-'));
  const legacy = join(home, 'Library', 'Application Support', 'Codex', 'job-application-agent');
  const next = join(home, 'Library', 'Application Support', 'job-application-agent');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, 'applications.ndjson'), '{"id":"keep"}\n');
  assert.equal(await migrateLegacyStateDir(next, { env: {}, home, plat: 'darwin' }), true);
  assert.equal(await readFile(join(next, 'applications.ndjson'), 'utf8'), '{"id":"keep"}\n');
  assert.equal(await readFile(join(legacy, 'applications.ndjson'), 'utf8'), '{"id":"keep"}\n');
});

test('darwin store migrates a legacy Keychain profile into the new service', () => {
  const keychain = new Map([[`${LEGACY_SECRET_SERVICE}/${PROFILE_ACCOUNT}`, JSON.stringify(sampleProfile)]]);
  const store = createSecretStore({ platform: 'darwin', execFileSync: darwinExec(keychain) });
  assert.deepEqual(JSON.parse(store.readProfile()), sampleProfile);
  assert.equal(keychain.get(`${DEFAULT_SECRET_SERVICE}/${PROFILE_ACCOUNT}`), JSON.stringify(sampleProfile));
  assert.equal(keychain.get(`${LEGACY_SECRET_SERVICE}/${PROFILE_ACCOUNT}`), JSON.stringify(sampleProfile));
});

test('darwin store writes only to the new Keychain service', () => {
  const keychain = new Map();
  const store = createSecretStore({ platform: 'darwin', execFileSync: darwinExec(keychain) });
  store.writeProfile(JSON.stringify(sampleProfile));
  assert.equal(keychain.get(`${DEFAULT_SECRET_SERVICE}/${PROFILE_ACCOUNT}`), JSON.stringify(sampleProfile));
  assert.equal(keychain.has(`${LEGACY_SECRET_SERVICE}/${PROFILE_ACCOUNT}`), false);
});

test('windows store keeps a wrapping key small and a profile larger than 2560 bytes', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'job-agent-win-store-'));
  const creds = new Map();
  const files = new Map();
  const store = createSecretStore({
    platform: 'win32',
    stateDir,
    execFileSync: windowsExec({ creds, files }),
  });
  const large = { ...sampleProfile, padding: 'x'.repeat(4000) };
  const serialized = JSON.stringify(large);
  assert.ok(Buffer.byteLength(serialized, 'utf8') > 2560);
  store.writeProfile(serialized);
  const [wrappingKey] = [...creds.values()];
  assert.ok(wrappingKey);
  assert.ok(Buffer.byteLength(wrappingKey, 'utf8') < 2560);
  assert.equal(JSON.stringify(JSON.parse(store.readProfile())), serialized);
  const profileFile = join(stateDir, 'profile.dat');
  assert.ok(files.get(profileFile).startsWith('DPAPI:'));
  assert.ok(files.get(profileFile).length > 2560);
});

function linuxSecretExec(secrets) {
  return (command, args, options) => {
    assert.equal(command, 'secret-tool');
    if (args[0] === 'lookup') {
      const service = args[args.indexOf('service') + 1];
      const account = args[args.indexOf('account') + 1];
      if (!secrets.has(`${service}/${account}`)) throw new Error('not found');
      return `${secrets.get(`${service}/${account}`)}\n`;
    }
    if (args[0] === 'store') {
      const service = args[args.indexOf('service') + 1];
      const account = args[args.indexOf('account') + 1];
      secrets.set(`${service}/${account}`, options.input);
      return '';
    }
    throw new Error(`unexpected secret-tool args: ${args.join(' ')}`);
  };
}

async function linuxStateDir(t, label) {
  const directory = await mkdtemp(join(tmpdir(), `job-agent-linux-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return directory;
}

test('linux store writes and reads the profile via Secret Service', () => {
  const secrets = new Map();
  const store = createSecretStore({ platform: 'linux', execFileSync: linuxSecretExec(secrets), env: {} });
  store.writeProfile(JSON.stringify(sampleProfile));
  assert.equal(store.readProfile(), JSON.stringify(sampleProfile));
});

test('linux store falls back to an owner-only file when secret-tool is missing (#289)', async (t) => {
  const directory = await linuxStateDir(t, 'enoent');
  const exec = () => { throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }); };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec, stateDir: directory, env: {} });
  store.writeProfile(JSON.stringify(sampleProfile));
  assert.equal(store.readProfile(), JSON.stringify(sampleProfile));
  const profileStat = await stat(join(directory, LINUX_FALLBACK_PROFILE));
  const keyStat = await stat(join(directory, LINUX_FALLBACK_KEY));
  if (process.platform !== 'win32') {
    assert.equal(profileStat.mode & 0o777, 0o600);
    assert.equal(keyStat.mode & 0o777, 0o600);
  }
  const raw = await readFile(join(directory, LINUX_FALLBACK_PROFILE), 'utf8');
  assert.equal(raw.includes(sampleProfile.email), false);
  assert.equal(raw.includes(sampleProfile.name), false);
});

test('linux store reads the fallback when Secret Service is locked (#289)', async (t) => {
  const directory = await linuxStateDir(t, 'locked-fallback');
  const missing = () => { throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }); };
  const writer = createSecretStore({ platform: 'linux', execFileSync: missing, stateDir: directory, env: {} });
  writer.writeProfile(JSON.stringify(sampleProfile));
  const locked = () => {
    throw Object.assign(new Error('secret-tool exited with status 1'), { stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n' });
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: locked, stateDir: directory, env: {} });
  assert.equal(store.readProfile(), JSON.stringify(sampleProfile));
});

test('linux store treats a successful empty lookup as a missing profile', async (t) => {
  const directory = await linuxStateDir(t, 'empty-lookup');
  const store = createSecretStore({ platform: 'linux', execFileSync: () => '', stateDir: directory, env: {} });
  assert.throws(() => store.readProfile(), (error) => isProfileMissingError(error));
});

test('linux store rejects profiles that secret-tool would silently truncate', () => {
  const stored = [];
  const exec = (command, args, options) => {
    assert.equal(command, 'secret-tool');
    assert.equal(args[0], 'store');
    stored.push(options.input);
    return '';
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec, env: {} });

  store.writeProfile('x'.repeat(LINUX_SECRET_MAX_BYTES));
  assert.equal(stored[0].length, LINUX_SECRET_MAX_BYTES);
  assert.throws(
    () => store.writeProfile('x'.repeat(LINUX_SECRET_MAX_BYTES + 1)),
    /too large for Linux Secret Service storage/,
  );
  assert.throws(
    () => store.writeProfile('é'.repeat((LINUX_SECRET_MAX_BYTES + 1) / 2)),
    /too large for Linux Secret Service storage/,
  );
  assert.equal(stored.length, 1);
});

test('linux store distinguishes an unavailable Secret Service from a missing profile (#289)', async (t) => {
  const directory = await linuxStateDir(t, 'unavailable');
  const exec = () => {
    throw Object.assign(new Error('secret-tool exited with status 1'), {
      stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n',
    });
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec, stateDir: directory, env: {} });

  assert.throws(() => store.readProfile(), (error) => {
    assert.equal(isProfileMissingError(error), false);
    assert.match(error.message, /Secret Service could not read the profile/);
    assert.match(error.message, /owner-only encrypted fallback/);
    assert.equal(error.telemetryErrorCode, 'authentication_required');
    assert.equal(error.recoverable, true);
    assert.equal(error.suppressTelemetry, false);
    assert.equal(error.message.includes(directory), false);
    return true;
  });
});

test('a second Linux keyring failure in the same state dir is sticky and non-retryable (#289)', async (t) => {
  const directory = await linuxStateDir(t, 'sticky');
  const exec = () => {
    throw Object.assign(new Error('secret-tool exited with status 1'), { stderr: 'Cannot unlock the keyring\n' });
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec, stateDir: directory, env: {} });
  let first;
  assert.throws(() => store.readProfile(), (error) => {
    first = error;
    assert.match(error.message, /Secret Service could not read the profile/);
    assert.equal(error.suppressTelemetry, false);
    assert.equal(error.recoverable, true);
    return true;
  });
  let second;
  assert.throws(() => store.readProfile(), (error) => {
    second = error;
    assert.match(error.message, /still unavailable in this run/);
    assert.equal(error.suppressTelemetry, true);
    assert.equal(error.recoverable, false);
    assert.match(error.message, /Do not retry the same command/);
    return true;
  });
  const firstProps = skillErrorProperties(first, 'profile');
  const secondProps = skillErrorProperties(second, 'profile');
  assert.equal(firstProps.errorCode, 'authentication_required');
  assert.equal(firstProps.recoverable, true);
  assert.equal(secondProps.errorCode, 'authentication_required');
  assert.equal(secondProps.recoverable, false);
  await stat(join(directory, LINUX_AUTH_MARKER));
});

test('linux store refreshes an existing fallback after a successful Secret Service write', async (t) => {
  const directory = await linuxStateDir(t, 'refresh-fallback');
  const secrets = new Map();
  const missing = () => { throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }); };
  const fallbackStore = createSecretStore({ platform: 'linux', execFileSync: missing, stateDir: directory, env: {} });
  fallbackStore.writeProfile(JSON.stringify(sampleProfile));

  let locked = false;
  const exec = (command, args, options) => {
    if (locked) throw Object.assign(new Error('locked'), { stderr: 'Cannot unlock the keyring\n' });
    return linuxSecretExec(secrets)(command, args, options);
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec, stateDir: directory, env: {} });
  const next = JSON.stringify({ ...sampleProfile, name: 'Latest' });
  store.writeProfile(next);
  assert.equal(store.readProfile(), next);
  locked = true;
  assert.equal(store.readProfile(), next);
});

test('linux fallback write leaves the previous file when the replacement fails', {
  skip: process.platform === 'win32',
}, async (t) => {
  const directory = await linuxStateDir(t, 'atomic-fallback');
  const missing = () => { throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }); };
  const store = createSecretStore({ platform: 'linux', execFileSync: missing, stateDir: directory, env: {} });
  store.writeProfile(JSON.stringify(sampleProfile));
  await chmod(directory, 0o500);
  try {
    assert.throws(() => store.writeProfile(JSON.stringify({ ...sampleProfile, name: 'Overwrite' })));
  } finally {
    await chmod(directory, 0o700);
  }
  assert.equal(store.readProfile(), JSON.stringify(sampleProfile));
});

test('linux store keeps a prior Secret Service profile readable when a later write uses the fallback', async (t) => {
  const directory = await linuxStateDir(t, 'write-fallback');
  const secrets = new Map();
  let failWrites = false;
  const exec = (command, args, options) => {
    assert.equal(command, 'secret-tool');
    if (args[0] === 'lookup') {
      if (failWrites) {
        throw Object.assign(new Error('locked'), { stderr: 'Cannot unlock the keyring\n' });
      }
      const service = args[args.indexOf('service') + 1];
      const account = args[args.indexOf('account') + 1];
      if (!secrets.has(`${service}/${account}`)) throw new Error('not found');
      return `${secrets.get(`${service}/${account}`)}\n`;
    }
    if (args[0] === 'store') {
      if (failWrites) throw Object.assign(new Error('keyring locked'), { stderr: 'Cannot unlock the keyring\n' });
      const service = args[args.indexOf('service') + 1];
      const account = args[args.indexOf('account') + 1];
      secrets.set(`${service}/${account}`, options.input);
      return '';
    }
    throw new Error(`unexpected secret-tool args: ${args.join(' ')}`);
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec, stateDir: directory, env: {} });
  store.writeProfile(JSON.stringify(sampleProfile));
  failWrites = true;
  const next = JSON.stringify({ ...sampleProfile, name: 'Overwrite' });
  store.writeProfile(next);
  assert.equal(store.readProfile(), next);
});

test('unsupported platforms retain an explicit profile storage error', () => {
  const store = createSecretStore({ platform: 'freebsd' });
  assert.throws(() => store.readProfile(), { message: UNSUPPORTED_PLATFORM_ERROR });
  assert.throws(() => store.writeProfile('{}'), { message: UNSUPPORTED_PLATFORM_ERROR });
});
