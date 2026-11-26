import assert from "node:assert/strict";
import test from "node:test";

test("built worker proxies /ingest to PostHog before SSR and strips cookies", async () => {
  const previousFetch = globalThis.fetch;
  /** @type {{ url: string, headers: Headers }[]} */
  const captured = [];
  globalThis.fetch = async (url, options = {}) => {
    captured.push({ url: String(url), headers: new Headers(options.headers) });
    return new Response("{}", { status: 200, headers: { "set-cookie": "ph=1" } });
  };
  try {
    const workerUrl = new URL("../dist/server/index.js", import.meta.url);
    workerUrl.searchParams.set("test", `ingest-${process.pid}-${Date.now()}`);
    const { default: worker } = await import(workerUrl.href);
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const env = { ASSETS: { fetch: async () => new Response("ssr-should-not-run", { status: 500 }) } };
    const response = await worker.fetch(new Request("https://jobappagent.com/ingest/i/v0/e/", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "founding_purchase=secret",
        referer: "https://jobappagent.com/?email=buyer@example.com",
      },
      body: JSON.stringify({ api_key: "phc_test", event: "$pageview", distinct_id: "anon" }),
    }), env, ctx);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("vercel-cdn-cache-control"), "private, no-store");
    assert.equal(captured.length, 1);
    assert.equal(captured[0].url, "https://us.i.posthog.com/i/v0/e/");
    assert.equal(captured[0].headers.get("cookie"), null);
    assert.equal(captured[0].headers.get("referer"), null);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
