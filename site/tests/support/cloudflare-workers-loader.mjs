// Lets `node --test` import the built Worker bundle (dist/server/index.js).
//
// From vinext 1.2 the production server bundle imports `cloudflare:workers`
// statically. That built-in module only exists inside workerd, so Node's ESM
// loader rejects it with ERR_UNSUPPORTED_ESM_URL_SCHEME. This hook resolves the
// specifier to a stand-in module, the same approach vinext uses for its own
// Node prerender and `vinext start` paths (vinext/dist/build/prerender-cloudflare-loader.js).
//
// The stand-in grants no bindings. Reading `env` or constructing a Worker class
// throws, so a render test that reaches a real binding still fails loudly. Bindings
// a test needs must be passed explicitly to `worker.fetch(request, env, ctx)`.
import { register } from 'node:module';

const stub = `
function unavailable() {
  throw new Error('cloudflare:workers bindings are not available under node --test; pass bindings to worker.fetch(request, env, ctx).');
}
const inaccessible = new Proxy({}, { get: unavailable, has: unavailable, ownKeys: unavailable, getOwnPropertyDescriptor: unavailable });
export const env = inaccessible;
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
