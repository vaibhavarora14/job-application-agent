import assert from "node:assert/strict";
import test from "node:test";

import {
  LANDING_SESSION_IDLE_MS,
  LANDING_SESSION_MAX_MS,
  bindLandingPageleave,
  captureLandingEvent,
  captureLandingPageleave,
  captureLandingPageview,
  getOrCreateLandingSessionId,
  isUuidV7,
  resetLandingAnalyticsStateForTests,
  uuidv7,
} from "../lib/landing-analytics.mjs";

function memoryStore(seed) {
  const map = new Map(seed ? Object.entries(seed) : []);
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    snapshot() { return Object.fromEntries(map); },
  };
}

function captureSink() {
  /** @type {{ url: string, body: Record<string, unknown>, keepalive?: boolean }[]} */
  const captured = [];
  return {
    captured,
    fetchFn: async (url, options) => {
      captured.push({
        url: String(url),
        body: JSON.parse(String(options.body)),
        keepalive: options.keepalive === true,
      });
      return new Response("{}", { status: 200 });
    },
  };
}

test("uuidv7 sets version 7 and a RFC 4122 variant", () => {
  const id = uuidv7(1_700_000_000_000, crypto.getRandomValues(new Uint8Array(16)));
  assert.equal(isUuidV7(id), true);
  assert.equal(id[14], "7");
  assert.match(id[19], /[89ab]/);
  assert.equal(isUuidV7(crypto.randomUUID()), false);
});

test("session id persists per tab store and rotates after idle or 24h", () => {
  resetLandingAnalyticsStateForTests();
  const store = memoryStore();
  const started = 1_700_000_000_000;
  const first = getOrCreateLandingSessionId({ sessionStore: store, now: started });
  assert.equal(isUuidV7(first), true);
  const touchedAt = started + 60_000;
  const same = getOrCreateLandingSessionId({ sessionStore: store, now: touchedAt });
  assert.equal(same, first);

  const afterIdle = getOrCreateLandingSessionId({
    sessionStore: store,
    now: touchedAt + LANDING_SESSION_IDLE_MS,
  });
  assert.equal(isUuidV7(afterIdle), true);
  assert.notEqual(afterIdle, first);

  const afterMax = getOrCreateLandingSessionId({
    sessionStore: store,
    now: touchedAt + LANDING_SESSION_IDLE_MS + LANDING_SESSION_MAX_MS,
  });
  assert.notEqual(afterMax, afterIdle);
});

test("every landing event carries a UUIDv7 $session_id, $host, and /ingest custom api host", async () => {
  resetLandingAnalyticsStateForTests();
  const { captured, fetchFn } = captureSink();
  const sessionStore = memoryStore();
  await captureLandingPageview({
    apiKey: "phc_public",
    host: "/ingest",
    pathname: "/",
    href: "https://jobappagent.com/",
    pageHost: "jobappagent.com",
    sessionStore,
    fetchFn,
  });
  await captureLandingEvent({
    apiKey: "phc_public",
    host: "/ingest",
    event: "founding_cta_clicked",
    pageHost: "jobappagent.com",
    sessionStore,
    fetchFn,
  });
  assert.equal(captured[0].url, "/ingest/i/v0/e/");
  for (const row of captured) {
    assert.equal(isUuidV7(row.body.properties.$session_id), true);
    assert.equal(row.body.properties.$host, "jobappagent.com");
    assert.equal(row.body.properties.$lib_custom_api_host, "/ingest");
    assert.equal(row.body.properties.$process_person_profile, false);
  }
  assert.equal(captured[0].body.properties.$session_id, captured[1].body.properties.$session_id);
});

test("pageleave uses sendBeacon once for pagehide and visibilitychange", async () => {
  resetLandingAnalyticsStateForTests();
  const { captured, fetchFn } = captureSink();
  const sessionStore = memoryStore();
  const sessionId = getOrCreateLandingSessionId({ sessionStore, now: 1_700_000_000_000 });
  /** @type {{ url: string, blob: Blob }[]} */
  const beacons = [];
  const sendBeacon = (url, blob) => {
    beacons.push({ url, blob });
    return true;
  };

  const first = await captureLandingPageleave({
    apiKey: "phc_public",
    host: "/ingest",
    pathname: "/",
    href: "https://jobappagent.com/",
    pageHost: "jobappagent.com",
    sessionId,
    sessionStore,
    fetchFn,
    sendBeacon,
  });
  const second = await captureLandingPageleave({
    apiKey: "phc_public",
    host: "/ingest",
    pathname: "/",
    href: "https://jobappagent.com/",
    pageHost: "jobappagent.com",
    sessionId,
    sessionStore,
    fetchFn,
    sendBeacon,
  });
  assert.equal(first.ok, true);
  assert.equal(first.transport, "beacon");
  assert.equal(second.duplicate, true);
  assert.equal(beacons.length, 1);
  assert.equal(captured.length, 0);
  const body = JSON.parse(await beacons[0].blob.text());
  assert.equal(body.event, "$pageleave");
  assert.equal(body.properties.$session_id, sessionId);
  assert.equal(body.properties.$current_url, "https://jobappagent.com/");
  assert.equal(body.properties.$pathname, "/");
  assert.equal(beacons[0].url, "/ingest/i/v0/e/");
});

test("bindLandingPageleave listens for pagehide and hidden visibility without double-send", async () => {
  resetLandingAnalyticsStateForTests();
  const { captured, fetchFn } = captureSink();
  const listeners = new Map();
  const docListeners = new Map();
  const fakeDocument = {
    visibilityState: "visible",
    addEventListener(type, handler) { docListeners.set(type, handler); },
    removeEventListener(type) { docListeners.delete(type); },
  };
  const fakeWindow = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    document: fakeDocument,
  };
  /** @type {{ url: string, blob: Blob }[]} */
  const beacons = [];
  const sendBeacon = (url, blob) => {
    beacons.push({ url, blob });
    return true;
  };
  const stop = bindLandingPageleave({
    apiKey: "phc_public",
    host: "/ingest",
    fetchFn,
    sendBeacon,
    pageHost: "jobappagent.com",
    sessionStore: memoryStore(),
    target: fakeWindow,
  });
  assert.equal(typeof listeners.get("pagehide"), "function");
  assert.equal(typeof docListeners.get("visibilitychange"), "function");
  listeners.get("pagehide")();
  fakeDocument.visibilityState = "hidden";
  docListeners.get("visibilitychange")();
  assert.equal(beacons.length, 1);
  assert.equal(captured.length, 0);
  const body = JSON.parse(await beacons[0].blob.text());
  assert.equal(body.event, "$pageleave");
  stop();
  assert.equal(listeners.has("pagehide"), false);
});

test("pageleave falls back to keepalive fetch when sendBeacon is missing", async () => {
  resetLandingAnalyticsStateForTests();
  const { captured, fetchFn } = captureSink();
  await captureLandingPageleave({
    apiKey: "phc_public",
    host: "/ingest",
    pathname: "/privacy",
    href: "https://jobappagent.com/privacy",
    pageHost: "jobappagent.com",
    sessionStore: memoryStore(),
    fetchFn,
    sendBeacon: undefined,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].keepalive, true);
  assert.equal(captured[0].body.event, "$pageleave");
  assert.equal(captured[0].body.properties.$pathname, "/privacy");
});
