// Lets `node --test` import the built Worker bundle (dist/server/index.js).
//
// From vinext 1.2 the production server bundle imports `cloudflare:workers`
// statically. That built-in module only exists inside workerd, so Node's ESM
// loader rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME. This hook resolves the
// specifier to a stand-in module, the same approach vinext uses for its own
// Node prerender and `vinext start` paths (vinext/dist/build/prerender-cloudflare-loader.js).
//
// Bindings: code that does `import { env } from "cloudflare:workers"` never sees
// what a test passes to `worker.fetch(request, env, ctx)`. A test that needs those
// module-level bindings installs them with `setCloudflareTestEnv({...})` from
// ./cloudflare-test-env.mjs (unset keys read as `undefined`, as in workerd).
// With nothing installed, reading `env` throws, so a render test that reaches a
// real binding by accident still fails loudly.
import { register } from 'node:module';

const stub = `
const KEY = Symbol.for('jobappagent.test.cloudflareEnv');
function unavailable() {
  throw new Error('cloudflare:workers env is not available under node --test; install bindings with setCloudflareTestEnv() from tests/support/cloudflare-test-env.mjs.');
}
function installed() {
  const value = globalThis[KEY];
  return value && typeof value === 'object' ? value : null;
}
export const env = new Proxy({}, {
  get(_target, key) { const bindings = installed(); if (!bindings) unavailable(); return bindings[key]; },
  has(_target, key) { const bindings = installed(); if (!bindings) unavailable(); return key in bindings; },
  ownKeys() { const bindings = installed(); if (!bindings) unavailable(); return Reflect.ownKeys(bindings); },
  getOwnPropertyDescriptor(_target, key) {
    const bindings = installed();
    if (!bindings) unavailable();
    return key in bindings ? { value: bindings[key], enumerable: true, configurable: true, writable: false } : undefined;
  },
});
const inaccessible = new Proxy({}, { get: unavailable, has: unavailable, ownKeys: unavailable, getOwnPropertyDescriptor: unavailable });
export const exports = inaccessible;
export const cache = inaccessible;
export const tracing = undefined;
export class WorkerEntrypoint { constructor() { unavailable(); } }
export class DurableObject { constructor() { unavailable(); } }
export class RpcTarget { constructor() { unavailable(); } }
export class WorkflowEntrypoint { constructor() { unavailable(); } }
export function waitUntil() { unavailable(); }
`;

const hooks = `
const STUB = ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)};
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:workers') return { shortCircuit: true, url: STUB };
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);
