import assert from 'node:assert/strict';
import test from 'node:test';

import { setCloudflareTestEnv } from './support/cloudflare-test-env.mjs';

test('cloudflare:workers env stub throws until bindings are installed, then serves them', async () => {
  const { env, tracing } = await import('cloudflare:workers');
  assert.equal(tracing, undefined);
  assert.throws(() => env.ATTENTION_MAGIC_LINK_SECRET, /setCloudflareTestEnv/);

  const restore = setCloudflareTestEnv({ ATTENTION_MAGIC_LINK_SECRET: 'test-secret-0123456789' });
  try {
    assert.equal(env.ATTENTION_MAGIC_LINK_SECRET, 'test-secret-0123456789');
    assert.equal(env.UNSET_BINDING, undefined);
    assert.equal('ATTENTION_MAGIC_LINK_SECRET' in env, true);
    assert.deepEqual(Object.keys(env), ['ATTENTION_MAGIC_LINK_SECRET']);
  } finally {
    restore();
  }
  assert.throws(() => env.ATTENTION_MAGIC_LINK_SECRET, /setCloudflareTestEnv/);
});
