import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createSecretStore,
  DEFAULT_SECRET_SERVICE,
  LEGACY_SECRET_SERVICE,
  LINUX_SECRET_MAX_BYTES,
  migrateLegacyStateDir,
  PROFILE_ACCOUNT,
  resolveStateDir,
  UNSUPPORTED_PLATFORM_ERROR,
} from '../scripts/secret-store.mjs';

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

test('linux store writes and reads the profile via Secret Service', () => {
  const secrets = new Map();
  const exec = (command, args, options) => {
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
  const store = createSecretStore({ platform: 'linux', execFileSync: exec });
  store.writeProfile(JSON.stringify(sampleProfile));
  assert.equal(store.readProfile(), JSON.stringify(sampleProfile));
});

test('linux store reports a clear error when secret-tool is not installed', () => {
  const exec = () => { throw Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' }); };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec });
  assert.throws(() => store.writeProfile(JSON.stringify(sampleProfile)), /libsecret-tools/);
  assert.throws(() => store.readProfile(), /libsecret-tools/);
});

test('linux store reports a clear error when keyring storage fails', () => {
  const exec = (command, args) => {
    assert.equal(command, 'secret-tool');
    if (args[0] === 'lookup') throw new Error('not found');
    throw new Error('keyring locked');
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec });
  assert.throws(() => store.writeProfile(JSON.stringify(sampleProfile)), /could not store the profile/);
  assert.throws(() => store.readProfile(), /missing or unreadable/);
});

test('linux store treats a successful empty lookup as a missing profile', () => {
  const store = createSecretStore({ platform: 'linux', execFileSync: () => '' });
  assert.throws(() => store.readProfile(), /missing or unreadable/);
});

test('linux store rejects profiles that secret-tool would silently truncate', () => {
  const stored = [];
  const exec = (command, args, options) => {
    assert.equal(command, 'secret-tool');
    assert.equal(args[0], 'store');
    stored.push(options.input);
    return '';
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec });

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

test('linux store distinguishes an unavailable Secret Service from a missing profile', () => {
  const exec = () => {
    throw Object.assign(new Error('secret-tool exited with status 1'), {
      stderr: 'secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n',
    });
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec });

  assert.throws(() => store.readProfile(), /Secret Service could not read the profile/);
});

test('linux store keeps a prior profile readable when a later write fails', () => {
  const secrets = new Map();
  let failWrites = false;
  const exec = (command, args, options) => {
    assert.equal(command, 'secret-tool');
    if (args[0] === 'lookup') {
      const service = args[args.indexOf('service') + 1];
      const account = args[args.indexOf('account') + 1];
      if (!secrets.has(`${service}/${account}`)) throw new Error('not found');
      return `${secrets.get(`${service}/${account}`)}\n`;
    }
    if (args[0] === 'store') {
      if (failWrites) throw new Error('keyring locked');
      const service = args[args.indexOf('service') + 1];
      const account = args[args.indexOf('account') + 1];
      secrets.set(`${service}/${account}`, options.input);
      return '';
    }
    throw new Error(`unexpected secret-tool args: ${args.join(' ')}`);
  };
  const store = createSecretStore({ platform: 'linux', execFileSync: exec });
  store.writeProfile(JSON.stringify(sampleProfile));
  failWrites = true;
  assert.throws(() => store.writeProfile(JSON.stringify({ ...sampleProfile, name: 'Overwrite' })), /could not store the profile/);
  assert.equal(store.readProfile(), JSON.stringify(sampleProfile));
});

test('unsupported platforms retain an explicit profile storage error', () => {
  const store = createSecretStore({ platform: 'freebsd' });
  assert.throws(() => store.readProfile(), { message: UNSUPPORTED_PLATFORM_ERROR });
  assert.throws(() => store.writeProfile('{}'), { message: UNSUPPORTED_PLATFORM_ERROR });
});
