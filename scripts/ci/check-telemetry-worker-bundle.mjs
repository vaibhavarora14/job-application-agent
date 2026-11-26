#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKER_ENTRY = join(ROOT, 'telemetry-worker/src/worker.mjs');
const WRANGLER_VERSION = '4.151.3';
const STATIC_NODE_CRYPTO = /\b(?:from|import)\s*(?:\(\s*)?['"]node:crypto['"]/;
const RELATIVE_IMPORT = /\bimport\s+(?:[^'"\n]+from\s*)?['"](\.[^'"]+)['"]/g;

export function staticNodeCryptoImport(source) {
  return STATIC_NODE_CRYPTO.test(source);
}

export async function collectWorkerModuleGraph(entry = WORKER_ENTRY) {
  const files = [];
  const queue = [entry];
  const seen = new Set();
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(RELATIVE_IMPORT)) {
      queue.push(fileURLToPath(new URL(match[1], pathToFileURL(file))));
    }
  }
  return files;
}

export async function filesWithStaticNodeCrypto(files) {
  const hits = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (staticNodeCryptoImport(source)) hits.push(file);
  }
  return hits;
}

function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `exit ${code}`).trim()));
    });
  });
}

async function wranglerDryRun() {
  const outdir = await mkdtemp(join(tmpdir(), 'jaa-telemetry-dry-run-'));
  try {
    await run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      '--yes',
      `wrangler@${WRANGLER_VERSION}`,
      'deploy',
      '--dry-run',
      `--outdir=${outdir}`,
      '--config',
      'telemetry-worker/wrangler.jsonc',
      '--env=',
    ], { cwd: ROOT });
  } finally {
    await rm(outdir, { recursive: true, force: true });
  }
}

async function main() {
  const files = await collectWorkerModuleGraph();
  const hits = await filesWithStaticNodeCrypto(files);
  if (hits.length) {
    const relative = hits.map((file) => file.slice(ROOT.length + 1)).join(', ');
    throw new Error(`telemetry-worker module graph statically imports node:crypto (${relative}). Cloudflare upload fails with 10021 unless nodejs_compat is enabled.`);
  }
  await wranglerDryRun();
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  if (import.meta.url === pathToFileURL(process.argv[1]).href) return true;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isEntrypoint()) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
