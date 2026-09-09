#!/usr/bin/env node
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  generateToken,
  listLocalAllowedFiles,
  loadConfig,
  pull,
  push,
  saveConfig,
  sha256Buffer,
  tokenSuffix,
  uniqueLegacyLedgerRows,
} from '../src/sync.mjs';

const ROOT = dirname(fileURLToPath(new URL('.', import.meta.url)));
const WORKER_URL = 'https://job-application-agent-state.varora1406.workers.dev';
const TOKEN_PATH = join(process.env.HOME, 'Library', 'Application Support', 'job-application-agent-cloud', 'config.json');

function wrangler(args, { input } = {}) {
  return execFileSync('wrangler', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input,
  });
}

async function configExists() {
  try {
    await stat(TOKEN_PATH);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function diffLegacy() {
  const home = process.env.HOME;
  const current = join(home, 'Library', 'Application Support', 'job-application-agent');
  const legacy = join(home, 'Library', 'Application Support', 'Codex', 'job-application-agent');
  const unique = await uniqueLegacyLedgerRows(current, legacy);
  return {
    uniqueLineExtras: unique.map(({ name, count }) => ({ name, count })),
    upload: 'current-only',
  };
}

async function resolveToken() {
  if (await configExists()) {
    const existing = await loadConfig();
    return { token: existing.token, reused: true };
  }
  const token = generateToken();
  wrangler(['secret', 'put', 'STATE_TOKEN'], { input: `${token}\n` });
  await saveConfig({ url: WORKER_URL, token });
  return { token, reused: false };
}

async function main() {
  const report = { workerUrl: WORKER_URL, tokenLocation: TOKEN_PATH, storage: 'workers-kv' };
  report.legacy = await diffLegacy();
  console.log(`legacy diff: ${JSON.stringify(report.legacy.uniqueLineExtras)}; uploading current folder only`);

  try {
    wrangler(['r2', 'bucket', 'create', 'job-application-agent-state']);
    report.bucket = 'created';
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message}`;
    if (/already exists|code: 10004/i.test(text)) report.bucket = 'exists';
    else if (/10042|enable R2/i.test(text)) {
      report.bucket = 'skipped-r2-not-entitled';
      console.log('R2 is not enabled (API 10042). Using the existing private Workers KV namespace.');
    } else {
      throw error;
    }
  }

  const { token, reused } = await resolveToken();
  report.secret = reused
    ? `STATE_TOKEN reused (ends with ${tokenSuffix(token)})`
    : `STATE_TOKEN set (ends with ${tokenSuffix(token)})`;
  console.log(`enable: config at ${TOKEN_PATH} (mode 0600). ${report.secret}`);

  const deployOut = wrangler(['deploy']);
  report.deploy = deployOut.trim().split('\n').filter((line) => /Deployed|workers.dev|Version/.test(line)).join(' | ');

  const pushed = await push({ fetchImpl: fetch });
  report.push = pushed.results.map((item) => `${item.name}:${item.action}`).join(', ');
  console.log(`push: ${pushed.results.length} objects`);

  const dest = await mkdtemp(join(tmpdir(), 'job-app-state-verify-'));
  try {
    const pulled = await pull({
      fetchImpl: fetch,
      stateDir: dest,
      secretStore: { readProfile() { return '{}'; }, writeProfile() {} },
    });
    const localFiles = await listLocalAllowedFiles(join(process.env.HOME, 'Library', 'Application Support', 'job-application-agent'));
    const mismatches = [];
    for (const { name, path } of localFiles) {
      const localHash = sha256Buffer(await readFile(path));
      const remoteBytes = await readFile(join(dest, name)).catch(() => null);
      const remoteHash = remoteBytes ? sha256Buffer(remoteBytes) : null;
      if (localHash !== remoteHash) mismatches.push(name);
    }
    report.pullVerify = mismatches.length === 0
      ? `ok (${pulled.results.filter((row) => row.name !== 'profile').length} files)`
      : `mismatch ${mismatches.join(',')}`;
    console.log(`pull verify: ${report.pullVerify}`);
  } finally {
    await rm(dest, { recursive: true, force: true });
  }

  const unauth = await fetch(`${WORKER_URL}/v1/manifest`);
  report.unauth = unauth.status;
  console.log(`tokenless GET /v1/manifest: ${unauth.status}`);
  if (unauth.status !== 401) {
    console.error('Expected 401 without a bearer token.');
    process.exit(1);
  }

  console.log(JSON.stringify({
    workerUrl: report.workerUrl,
    storage: report.storage,
    bucket: report.bucket,
    secret: report.secret,
    tokenLocation: report.tokenLocation,
    deploy: report.deploy,
    push: report.push,
    pullVerify: report.pullVerify,
    unauth: report.unauth,
    legacy: report.legacy,
  }, null, 2));
}

await main();
