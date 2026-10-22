// Loaded by `npm test` (node --test --import ...) before every test file.
// 1. Marks the process tree as a test run: JAA_TEST=1 is inherited by every CLI a test spawns
//    with process.env, so its default relay endpoint is the local mock, not production.
// 2. Makes any in-process fetch to the production relay fail loudly instead of registering
//    installs or events in the live relay, PostHog, and the public counts.
// Opt in to the live relay explicitly with JAA_TEST_LIVE_TELEMETRY=1.
export const PRODUCTION_RELAY_HOST = 'job-application-agent-telemetry.varora1406.workers.dev';

if (!process.env.JAA_TEST) process.env.JAA_TEST = '1';

const live = String(process.env.JAA_TEST_LIVE_TELEMETRY ?? '').trim() === '1';
if (!live && typeof globalThis.fetch === 'function' && !globalThis.fetch.jaaProductionRelayGuard) {
  const realFetch = globalThis.fetch;
  const guarded = function fetch(input, init) {
    let host = '';
    try { host = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input?.url).hostname; } catch { /* not a URL: let fetch report it */ }
    if (host === PRODUCTION_RELAY_HOST) {
      return Promise.reject(new Error(`test run tried to reach the production telemetry relay (${host}); use a mock or set JAA_TEST_LIVE_TELEMETRY=1`));
    }
    return realFetch.call(this, input, init);
  };
  guarded.jaaProductionRelayGuard = true;
  globalThis.fetch = guarded;
}
