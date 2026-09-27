import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_POSTHOG_HOST,
  FOUNDING_EVENTS,
  POSTHOG_CONNECT_SRC,
  buildPostHogCaptureBody,
  captureSitePostHogEvent,
  extractUtmParams,
  foundingEventProperties,
  hashPurchaseId,
  resolvePostHogHost,
} from "../lib/posthog.mjs";
import {
  captureLandingEvent,
  captureLandingPageview,
  readUtmFromLocation,
} from "../lib/landing-analytics.mjs";

const purchaseId = "11111111-1111-4111-8111-111111111111";

test("extractUtmParams keeps only allowlisted non-empty UTM strings", () => {
  assert.deepEqual(
    extractUtmParams({
      utm_source: " twitter ",
      utm_medium: "cpc",
      utm_campaign: ["spring", "ignored"],
      utm_term: "",
      email: "buyer@example.com",
      purchaseId,
    }),
    { utm_source: "twitter", utm_medium: "cpc", utm_campaign: "spring" },
  );
  assert.deepEqual(extractUtmParams(null), {});
});

test("hashPurchaseId is stable and does not echo the raw id", async () => {
  const first = await hashPurchaseId(purchaseId);
  const second = await hashPurchaseId(purchaseId);
  assert.equal(first, second);
  assert.equal(first.length, 64);
  assert.equal(first.includes(purchaseId), false);
  assert.notEqual(await hashPurchaseId("22222222-2222-4222-8222-222222222222"), first);
});

test("buildPostHogCaptureBody forces personless + geoip-disabled properties", () => {
  const body = buildPostHogCaptureBody({
    apiKey: "phc_test",
    event: FOUNDING_EVENTS.CHECKOUT_CREATED,
    distinctId: "abc",
    properties: { offer: "founding_90_days", email: "leak@example.com" },
    timestamp: "2026-09-27T00:00:00.000Z",
  });
  assert.equal(body.api_key, "phc_test");
  assert.equal(body.event, "founding_checkout_created");
  assert.equal(body.distinct_id, "abc");
  assert.equal(body.properties.$process_person_profile, false);
  assert.equal(body.properties.$geoip_disable, true);
  assert.equal(body.properties.offer, "founding_90_days");
  // Helper does not strip caller mistakes — callers must never pass email.
  assert.equal(body.properties.email, "leak@example.com");
});

test("foundingEventProperties exposes hash + offer without raw purchase id", async () => {
  const properties = await foundingEventProperties(purchaseId, {
    status: "succeeded",
    amount: 4900,
    currency: "USD",
  });
  assert.equal(properties.offer, "founding_90_days");
  assert.equal(properties.status, "succeeded");
  assert.equal(properties.amount, 4900);
  assert.equal(typeof properties.purchaseIdHash, "string");
  assert.equal(JSON.stringify(properties).includes(purchaseId), false);
  assert.equal("email" in properties, false);
});

test("captureSitePostHogEvent skips when API key missing and posts when present", async () => {
  const skipped = await captureSitePostHogEvent({}, {
    event: FOUNDING_EVENTS.PAYMENT_CONFIRMED,
    distinctId: "x",
  });
  assert.deepEqual(skipped, { ok: false, skipped: true });

  /** @type {unknown[]} */
  const captured = [];
  const ok = await captureSitePostHogEvent({
    POSTHOG_PROJECT_API_KEY: "phc_test",
    POSTHOG_HOST: "https://us.i.posthog.com",
    POSTHOG_FETCH: async (url, options) => {
      captured.push({ url, body: JSON.parse(String(options.body)) });
      return new Response("{}", { status: 200 });
    },
  }, {
    event: FOUNDING_EVENTS.CHECKOUT_CREATED,
    distinctId: "distinct",
    properties: { purchaseIdHash: "hash", status: "checkout_created" },
  });
  assert.equal(ok.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "https://us.i.posthog.com/i/v0/e/");
  assert.equal(captured[0].body.event, "founding_checkout_created");
  assert.equal(captured[0].body.distinct_id, "distinct");
  assert.equal(captured[0].body.properties.purchaseIdHash, "hash");
  assert.equal(captured[0].body.properties.$process_person_profile, false);
  assert.equal(JSON.stringify(captured[0]).includes("buyer@"), false);
});

test("resolvePostHogHost rejects non-https remote hosts", () => {
  assert.equal(resolvePostHogHost(undefined), DEFAULT_POSTHOG_HOST);
  assert.equal(resolvePostHogHost("https://eu.i.posthog.com/"), "https://eu.i.posthog.com");
  assert.equal(resolvePostHogHost("http://evil.example"), DEFAULT_POSTHOG_HOST);
  assert.equal(POSTHOG_CONNECT_SRC.includes(DEFAULT_POSTHOG_HOST), true);
});

test("landing helpers read UTM from search and capture pageviews", async () => {
  assert.deepEqual(
    readUtmFromLocation("?utm_source=x&utm_medium=y&email=nope@example.com"),
    { utm_source: "x", utm_medium: "y" },
  );

  /** @type {unknown[]} */
  const captured = [];
  const pageview = await captureLandingPageview({
    apiKey: "phc_public",
    host: "https://us.i.posthog.com",
    pathname: "/",
    search: "?utm_campaign=launch",
    href: "https://jobappagent.com/?utm_campaign=launch",
    fetchFn: async (url, options) => {
      captured.push({ url, body: JSON.parse(String(options.body)) });
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(pageview.ok, true);
  assert.equal(captured[0].body.event, "$pageview");
  assert.equal(captured[0].body.properties.path, "/");
  assert.equal(captured[0].body.properties.utm_campaign, "launch");

  const event = await captureLandingEvent({
    apiKey: "phc_public",
    host: "https://us.i.posthog.com",
    event: FOUNDING_EVENTS.CTA_CLICKED,
    distinctId: "anon-1",
    properties: { offer: "founding_90_days", utm_source: "x" },
    fetchFn: async (url, options) => {
      captured.push({ url, body: JSON.parse(String(options.body)) });
      return new Response("{}", { status: 200 });
    },
  });
  assert.equal(event.ok, true);
  assert.equal(captured[1].body.event, "founding_cta_clicked");
  assert.equal(captured[1].body.distinct_id, "anon-1");
  assert.equal(captured[1].body.properties.utm_source, "x");
});

test("docs and source never embed committed PostHog project keys", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    new URL("../lib/posthog.mjs", import.meta.url),
    new URL("../lib/landing-analytics.mjs", import.meta.url),
    new URL("../README.md", import.meta.url),
    new URL("../docs/POSTHOG.md", import.meta.url),
    new URL("../.env.example", import.meta.url),
    new URL("../wrangler.jsonc", import.meta.url),
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /phc_[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(text, /POSTHOG_PROJECT_API_KEY\s*=\s*phc_/);
    assert.doesNotMatch(text, /PUBLIC_POSTHOG_KEY\s*=\s*phc_/);
  }
});
