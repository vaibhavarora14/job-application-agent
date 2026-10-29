// Node test harness only: the built Worker (vinext >= 1.3) statically imports `cloudflare:workers`
// for its tracing hook. Node's ESM loader rejects that scheme, so map it to an inert stub.
// Route tests pass bindings to `worker.fetch(...)` directly; nothing here grants real bindings.
import { register } from "node:module";

const stub = `
export const tracing = undefined;
export const env = {};
export const exports = {};
export function waitUntil() {}
export class WorkerEntrypoint {}
export class DurableObject {}
export class RpcTarget {}
export class WorkflowEntrypoint {}
`;

const hooks = `
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { shortCircuit: true, url: ${JSON.stringify(`data:text/javascript,${encodeURIComponent(stub)}`)} };
  }
  return nextResolve(specifier, context);
}
`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`);
