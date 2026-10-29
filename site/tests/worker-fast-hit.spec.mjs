import assert from "node:assert/strict";
import test from "node:test";

// The built Worker answers fresh edge-cache hits before entering Sentry and the app
// router. The response must be the same one the full path returns: same body, same
// security headers, and always Vercel-CDN-Cache-Control: private, no-store (#204).
test("fresh cache hit served by the fast path matches the full path and keeps private, no-store", async () => {
  const store = new Map();
  const previous = globalThis.caches;
  globalThis.caches = {
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? new Response(hit.body, { status: hit.status, headers: hit.headers }) : undefined;
      },
      async put(request, response) {
        store.set(request.url, { body: await response.arrayBuffer(), status: response.status, headers: [...response.headers] });
      },
    },
  };
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `fast-hit-${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const pending = [];
    const ctx = { waitUntil(promise) { pending.push(promise); }, passThroughOnException() {} };
    const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, SENTRY_RELEASE: "fast-hit-test" };
    const get = (host) => worker.fetch(new Request("https://job-application-agent-site.varora1406.workers.dev/terms", { headers: { accept: "text/html", "x-forwarded-host": host } }), env, ctx);

    const miss = await get("jobappagent.com");
    assert.equal(miss.headers.get("x-cache"), "MISS");
    const missBody = await miss.text();
    await Promise.all(pending.splice(0));

    const hit = await get("jobappagent.com");
    assert.equal(hit.status, 200);
    assert.equal(hit.headers.get("x-cache"), "HIT");
    assert.equal(await hit.text(), missBody);
    assert.equal(hit.headers.get("vercel-cdn-cache-control"), "private, no-store");
    for (const name of ["content-security-policy", "x-content-type-options", "x-frame-options", "content-type"]) {
      assert.equal(hit.headers.get(name), miss.headers.get(name), name);
    }
    assert.match(hit.headers.get("cache-control") ?? "", /s-maxage=86400/);

    // Host stays in the key: the stats host never gets the apex copy.
    const stats = await get("stats.jobappagent.com");
    assert.equal(stats.headers.get("x-cache"), "MISS");
    assert.equal(stats.headers.get("vercel-cdn-cache-control"), "private, no-store");
    await stats.arrayBuffer();
  } finally {
    if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;
  }
});
