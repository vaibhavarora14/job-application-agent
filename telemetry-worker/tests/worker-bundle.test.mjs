import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  collectWorkerModuleGraph,
  filesWithStaticNodeCrypto,
  staticNodeCryptoImport,
  wranglerDryRunSupported,
} from '../../scripts/ci/check-telemetry-worker-bundle.mjs';

test('static node:crypto import detector matches Worker upload failures', () => {
  assert.equal(staticNodeCryptoImport("import { createHash } from 'node:crypto';\n"), true);
  assert.equal(staticNodeCryptoImport('import { createHash } from "node:crypto";\n'), true);
  assert.equal(staticNodeCryptoImport("const { createHash } = await import('node:crypto');\n"), true);
  assert.equal(staticNodeCryptoImport("await import(['node', 'crypto'].join(':'));\n"), false);
  assert.equal(staticNodeCryptoImport('const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);\n'), false);
});

test('telemetry-worker module graph has no static node:crypto import', async () => {
  const files = await collectWorkerModuleGraph();
  assert.ok(files.some((file) => file.endsWith(path.join('job-application-agent', 'scripts', 'telemetry-schema.mjs'))));
  assert.deepEqual(await filesWithStaticNodeCrypto(files), []);
});

test('wrangler dry-run is Node 22+ only (CLI high-risk still runs Node 20)', () => {
  assert.equal(wranglerDryRunSupported('20.20.2'), false);
  assert.equal(wranglerDryRunSupported('21.7.3'), false);
  assert.equal(wranglerDryRunSupported('22.0.0'), true);
  assert.equal(wranglerDryRunSupported('24.1.0'), true);
});
