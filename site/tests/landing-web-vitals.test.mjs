import assert from "node:assert/strict";
import test from "node:test";

import { resetLandingAnalyticsStateForTests } from "../lib/landing-analytics.mjs";
import {
  bindLandingWebVitals,
  webVitalsToPostHogProperties,
} from "../lib/landing-web-vitals.mjs";

function memoryStore() {
  const map = new Map();
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
  };
}

test("web vitals properties match PostHog $web_vitals_<NAME>_value / _event shape", () => {
  const properties = webVitalsToPostHogProperties([
    { name: "LCP", value: 1200, rating: "good", delta: 1200, id: "v1", navigationType: "navigate" },
    { name: "CLS", value: 0.04, rating: "good", delta: 0.04, id: "v2", navigationType: "navigate" },
    { name: "INP", value: 80, rating: "good", delta: 80, id: "v3", navigationType: "navigate" },
    { name: "FCP", value: 400 },
  ]);
  assert.equal(properties.$web_vitals_LCP_value, 1200);
  assert.equal(properties.$web_vitals_CLS_value, 0.04);
  assert.equal(properties.$web_vitals_INP_value, 80);
  assert.equal(properties.$web_vitals_FCP_value, undefined);
  assert.equal(properties.$web_vitals_LCP_event.name, "LCP");
  assert.equal(properties.$web_vitals_LCP_event.rating, "good");
  assert.equal("attribution" in properties.$web_vitals_LCP_event, false);
  assert.equal("entries" in properties.$web_vitals_LCP_event, false);
});

test("bindLandingWebVitals flushes LCP/CLS/INP as one $web_vitals event", async () => {
  resetLandingAnalyticsStateForTests();
  /** @type {{ body: Record<string, unknown> }[]} */
  const captured = [];
  /** @type {Record<string, Function>} */
  const callbacks = {};
  const stop = bindLandingWebVitals({
    apiKey: "phc_public",
    host: "/ingest",
    pathname: "/",
    href: "https://jobappagent.com/",
    pageHost: "jobappagent.com",
    sessionStore: memoryStore(),
    flushMs: 60_000,
    setTimeoutFn: () => 0,
    clearTimeoutFn() {},
    fetchFn: async (_url, options) => {
      captured.push({ body: JSON.parse(String(options.body)) });
      return new Response("{}", { status: 200 });
    },
  }, {
    onLCP(cb) { callbacks.LCP = cb; },
    onCLS(cb) { callbacks.CLS = cb; },
    onINP(cb) { callbacks.INP = cb; },
  });

  callbacks.LCP({ name: "LCP", value: 1800, rating: "needs-improvement" });
  callbacks.CLS({ name: "CLS", value: 0.02, rating: "good" });
  assert.equal(captured.length, 0);
  callbacks.INP({ name: "INP", value: 150, rating: "good" });
  await Promise.resolve();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.event, "$web_vitals");
  assert.equal(captured[0].body.properties.$web_vitals_LCP_value, 1800);
  assert.equal(captured[0].body.properties.$web_vitals_CLS_value, 0.02);
  assert.equal(captured[0].body.properties.$web_vitals_INP_value, 150);
  assert.equal(captured[0].body.properties.$current_url, "https://jobappagent.com/");
  assert.equal(captured[0].body.properties.$pathname, "/");
  assert.match(String(captured[0].body.properties.$session_id), /^[0-9a-f-]{36}$/i);
  stop();
});

test("bindLandingWebVitals does not send twice when hidden fires after a full flush", async () => {
  resetLandingAnalyticsStateForTests();
  /** @type {unknown[]} */
  const captured = [];
  /** @type {Record<string, Function>} */
  const callbacks = {};
  bindLandingWebVitals({
    apiKey: "phc_public",
    host: "/ingest",
    pathname: "/",
    href: "https://jobappagent.com/",
    pageHost: "jobappagent.com",
    sessionStore: memoryStore(),
    flushMs: 60_000,
    setTimeoutFn: () => 0,
    clearTimeoutFn() {},
    fetchFn: async (_url, options) => {
      captured.push(JSON.parse(String(options.body)));
      return new Response("{}", { status: 200 });
    },
    sendBeacon: (url, blob) => {
      captured.push(JSON.parse(new TextDecoder().decode(blob)));
      return true;
    },
  }, {
    onLCP(cb) { callbacks.LCP = cb; },
    onCLS(cb) { callbacks.CLS = cb; },
    onINP(cb) { callbacks.INP = cb; },
  });
  callbacks.LCP({ name: "LCP", value: 900 });
  callbacks.CLS({ name: "CLS", value: 0.01 });
  callbacks.INP({ name: "INP", value: 40 });
  await Promise.resolve();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("pagehide"));
  }
  assert.equal(captured.length, 1);
});
