import assert from "node:assert/strict";
import test from "node:test";

import {
  POSTHOG_EU_ASSETS_HOST,
  POSTHOG_US_ASSETS_HOST,
  isPostHogIngestPath,
  postHogProxyTargets,
  postHogProxyUpstreamUrl,
  proxyPostHogIngest,
  shouldForwardPostHogAuthorization,
} from "../lib/posthog-ingest-proxy.mjs";

test("ingest prefix maps capture to US ingest and assets to the assets host", () => {
  assert.equal(isPostHogIngestPath("/ingest"), true);
  assert.equal(isPostHogIngestPath("/ingest/i/v0/e/"), true);
  assert.equal(isPostHogIngestPath("/api/analytics-config"), false);
  assert.equal(postHogProxyTargets().ingest, "https://us.i.posthog.com");
  assert.equal(postHogProxyTargets().assets, POSTHOG_US_ASSETS_HOST);
  assert.equal(postHogProxyTargets("https://eu.i.posthog.com").assets, POSTHOG_EU_ASSETS_HOST);
  assert.equal(
    postHogProxyUpstreamUrl("https://jobappagent.com/ingest/i/v0/e/?v=1", undefined).href,
    "https://us.i.posthog.com/i/v0/e/?v=1",
  );
  assert.equal(
    postHogProxyUpstreamUrl("https://jobappagent.com/ingest/static/array.js", undefined).href,
    `${POSTHOG_US_ASSETS_HOST}/static/array.js`,
  );
  assert.equal(
    postHogProxyUpstreamUrl("https://jobappagent.com/ingest/array/phc_x/config", undefined).href,
    `${POSTHOG_US_ASSETS_HOST}/array/phc_x/config`,
  );
});

test("proxy forwards POST capture, strips cookies/referer, and drops Set-Cookie", async () => {
  /** @type {{ url: string, method: string, headers: Headers, body: string }[]} */
  const captured = [];
  const response = await proxyPostHogIngest(new Request("https://jobappagent.com/ingest/i/v0/e/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: "founding_purchase=secret",
      referer: "https://jobappagent.com/?email=buyer@example.com",
      "user-agent": "LandingTest/1.0",
      "cf-connecting-ip": "203.0.113.9",
    },
    body: JSON.stringify({ api_key: "phc_test", event: "$pageview", distinct_id: "anon" }),
  }), {
    fetchFn: async (url, options) => {
      captured.push({
        url: String(url),
        method: options.method,
        headers: new Headers(options.headers),
        body: new TextDecoder().decode(options.body),
      });
      return new Response("{}", {
        status: 200,
        headers: { "set-cookie": "ph=leak", "content-type": "application/json" },
      });
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(captured[0].url, "https://us.i.posthog.com/i/v0/e/");
  assert.equal(captured[0].method, "POST");
  assert.equal(captured[0].headers.get("cookie"), null);
  assert.equal(captured[0].headers.get("referer"), null);
  assert.equal(captured[0].headers.get("content-type"), "application/json");
  assert.equal(captured[0].headers.get("user-agent"), "LandingTest/1.0");
  assert.equal(captured[0].headers.get("x-forwarded-for"), "203.0.113.9");
  assert.equal(captured[0].body.includes("buyer@example.com"), false);
  assert.equal(captured[0].body.includes("$pageview"), true);
});

test("proxy forwards PostHog bearer tokens and strips other Authorization", async () => {
  assert.equal(shouldForwardPostHogAuthorization("Bearer phc_abc"), true);
  assert.equal(shouldForwardPostHogAuthorization("Bearer session"), false);
  /** @type {Headers | null} */
  let headers = null;
  await proxyPostHogIngest(new Request("https://jobappagent.com/ingest/flags/?v=2", {
    method: "GET",
    headers: { authorization: "Bearer session-token" },
  }), {
    fetchFn: async (_url, options) => {
      headers = new Headers(options.headers);
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(headers.get("authorization"), null);

  await proxyPostHogIngest(new Request("https://jobappagent.com/ingest/flags/?v=2", {
    method: "GET",
    headers: { authorization: "Bearer phc_project" },
  }), {
    fetchFn: async (_url, options) => {
      headers = new Headers(options.headers);
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(headers.get("authorization"), "Bearer phc_project");
});

test("proxy allows GET/POST/HEAD/OPTIONS and rejects other methods", async () => {
  const options = await proxyPostHogIngest(new Request("https://jobappagent.com/ingest/i/v0/e/", { method: "OPTIONS" }));
  assert.equal(options.status, 204);
  const put = await proxyPostHogIngest(new Request("https://jobappagent.com/ingest/i/v0/e/", { method: "PUT" }));
  assert.equal(put.status, 405);
});
