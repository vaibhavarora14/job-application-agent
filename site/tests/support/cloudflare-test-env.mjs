// Install module-level `cloudflare:workers` env bindings for node --test (see cloudflare-workers-loader.mjs).
const KEY = Symbol.for('jobappagent.test.cloudflareEnv');

/** Install bindings read via `import { env } from "cloudflare:workers"`; returns a restore function. */
export function setCloudflareTestEnv(bindings) {
  const previous = globalThis[KEY];
  globalThis[KEY] = { ...bindings };
  return () => {
    if (previous === undefined) delete globalThis[KEY];
    else globalThis[KEY] = previous;
  };
}
