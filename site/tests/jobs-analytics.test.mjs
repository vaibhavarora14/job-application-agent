import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";
import {
  JOBS_ANALYTICS_WINDOW_KEY,
  JOBS_COPY_KINDS,
  JOBS_EVENTS,
  JOBS_SOURCE_GOOGLE_FOR_JOBS,
  JOBS_UTM_KEYS,
  captureJobsCopyClicked,
  captureJobsPageview,
  classifyJobsSurface,
  detectGoogleForJobsLanding,
  isGoogleJobsReferrerHost,
  isJobsCopyKind,
  jobsAttributionProperties,
  jobsCaptureHost,
  jobsCaptureUrl,
  normalizeJobsPathname,
  readJobsUtmFromLocation,
  referrerHostname,
  rememberJobsDocumentTouch,
  resetJobsAnalyticsForTests,
  setJobsAnalyticsBrowserConfig,
  trackJobsCopyClicked,
} from "../lib/jobs-analytics.mjs";
import { isUuidV7 } from "../lib/landing-analytics.mjs";
import { BROWSER_POSTHOG_INGEST_PATH, DEFAULT_POSTHOG_HOST } from "../lib/posthog.mjs";

const DISTINCT = "11111111-1111-4111-8111-111111111111";

/** @param {unknown[]} captured */
function fetchRecorder(captured) {
  return async (url, options) => {
    captured.push({ url, body: JSON.parse(String(options.body)) });
    return new Response("{}", { status: 200 });
  };
}

function assertNoQueryOrReferrerLeak(serialized) {
  assert.doesNotMatch(serialized, /"\$referrer"/);
  assert.doesNotMatch(serialized, /"\$referring_domain"/);
  assert.equal(serialized.includes("secret-query"), false);
  assert.equal(serialized.includes("jane+doe"), false);
  assert.equal(serialized.includes("nope@example.com"), false);
  assert.equal(serialized.includes("gclid"), false);
  assert.equal(serialized.includes("abc123"), false);
  assert.equal(serialized.includes("utm_term"), false);
  assert.equal(serialized.includes("utm_content"), false);
  assert.equal(serialized.includes("utm_source"), false);
  assert.equal(serialized.includes("utm_medium"), false);
  assert.equal(serialized.includes("utm_campaign"), false);
  assert.equal(serialized.includes("google_jobs_apply"), false);
  assert.equal(serialized.includes("workplace=remote"), false);
  assert.doesNotMatch(serialized, /[?&]q=/);
}

test("classifyJobsSurface maps board and slug pages and skips alerts", () => {
  assert.equal(classifyJobsSurface("/jobs"), "board");
  assert.equal(classifyJobsSurface("/jobs/"), "board");
  assert.equal(classifyJobsSurface("/jobs/example-labs-senior-backend-engineer-aaaaaaaaaaaaaaaa"), "job_page");
  assert.equal(classifyJobsSurface("/jobs/alerts/confirm"), null);
  assert.equal(classifyJobsSurface("/jobs/alerts/unsubscribe"), null);
  assert.equal(classifyJobsSurface("/jobs/alerts"), null);
  assert.equal(classifyJobsSurface("/"), null);
  assert.equal(classifyJobsSurface("/jobs/foo/bar"), null);
});

test("jobsCaptureUrl drops query, hash, and referrer material", () => {
  assert.equal(
    jobsCaptureUrl({
      origin: "https://jobappagent.com",
      pathname: "/jobs",
      href: "https://jobappagent.com/jobs?workplace=remote&utm_source=google&email=jane@example.com#top",
    }),
    "https://jobappagent.com/jobs",
  );
  assert.equal(
    jobsCaptureUrl({
      href: "https://jobappagent.com/jobs/example-slug?utm_campaign=secret#x",
    }),
    "https://jobappagent.com/jobs/example-slug",
  );
  assert.equal(normalizeJobsPathname("/jobs/?q=1"), "/jobs");
});

test("detectGoogleForJobsLanding uses host/UTM only and ignores paid clicks", () => {
  const leakyReferrer = "https://www.google.com/search?q=jane+doe+email%40x.com";
  assert.equal(referrerHostname(leakyReferrer), "www.google.com");
  assert.equal(isGoogleJobsReferrerHost("www.google.com"), true);
  assert.equal(isGoogleJobsReferrerHost("jobs.google.com"), true);
  assert.equal(isGoogleJobsReferrerHost("google.co.uk"), true);
  assert.equal(isGoogleJobsReferrerHost("mail.google.com"), false);
  assert.equal(isGoogleJobsReferrerHost("news.google.com"), false);

  assert.equal(detectGoogleForJobsLanding({ referrer: leakyReferrer }), true);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=google&utm_medium=organic" }), true);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=google_jobs" }), true);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=google_jobs_apply&utm_medium=organic" }), true);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=google_jobs_apply" }), true);
  assert.equal(detectGoogleForJobsLanding({
    search: "?utm_campaign=google_jobs_apply&utm_medium=organic",
  }), true);
  assert.equal(detectGoogleForJobsLanding({
    referrer: leakyReferrer,
    search: "?utm_source=google_jobs_apply&utm_medium=organic",
  }), true);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=google&utm_medium=cpc" }), false);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=google&utm_medium=paidsearch" }), false);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=google&utm_medium=email" }), false);
  assert.equal(detectGoogleForJobsLanding({
    referrer: leakyReferrer,
    search: "?gclid=abc123",
  }), false);
  assert.equal(detectGoogleForJobsLanding({
    search: "?utm_source=google_jobs_apply&gclid=abc123",
  }), false);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=twitter" }), false);
  assert.equal(detectGoogleForJobsLanding({
    referrer: leakyReferrer,
    search: "?utm_source=twitter",
  }), false);
  assert.equal(detectGoogleForJobsLanding({ referrer: "https://example.net/share" }), false);
});

test("jobs board pageview is personless and strips query plus referrer", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const result = await captureJobsPageview({
    apiKey: "phc_public",
    host: "https://us.i.posthog.com",
    pathname: "/jobs",
    search: "?workplace=remote&utm_source=twitter&email=nope@example.com",
    origin: "https://jobappagent.com",
    href: "https://jobappagent.com/jobs?workplace=remote&utm_source=twitter&email=nope@example.com",
    referrer: "https://example.net/share?q=secret-query",
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.event, "$pageview");
  assert.equal(captured[0].body.properties.surface, "board");
  assert.equal(captured[0].body.properties.$pathname, "/jobs");
  assert.equal(captured[0].body.properties.$current_url, "https://jobappagent.com/jobs");
  assert.equal("utm_source" in captured[0].body.properties, false);
  assert.equal("$referring_domain" in captured[0].body.properties, false);
  assert.equal("googleForJobs" in captured[0].body.properties, false);
  assert.equal("jobsSource" in captured[0].body.properties, false);
  assert.equal(captured[0].body.properties.$process_person_profile, false);
  assert.equal(captured[0].body.properties.$geoip_disable, true);
  assert.equal(captured[0].url, `${BROWSER_POSTHOG_INGEST_PATH}/i/v0/e/`);
  assert.equal(captured[0].body.properties.$lib_custom_api_host, BROWSER_POSTHOG_INGEST_PATH);
  assert.equal(isUuidV7(captured[0].body.properties.$session_id), true);
  assert.deepEqual(
    Object.keys(captured[0].body.properties).sort(),
    [
      "$current_url",
      "$geoip_disable",
      "$lib_custom_api_host",
      "$pathname",
      "$process_person_profile",
      "$session_id",
      "path",
      "surface",
    ].sort(),
  );
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("workplace=remote"), false);
  assert.equal(serialized.includes("secret-query"), false);
  assert.equal(serialized.includes("/share"), false);
  assert.equal(serialized.includes("nope@example.com"), false);
  assert.equal(serialized.includes("twitter"), false);
  assert.equal("$referrer" in captured[0].body.properties, false);
  assert.doesNotMatch(serialized, /"\$referrer"/);
  assertNoQueryOrReferrerLeak(serialized);
});

test("Google search referrer with a query string is detected without leaking the URL", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const leakyReferrer = "https://www.google.com/search?q=jane+doe+email%40x.com";
  const result = await captureJobsPageview({
    apiKey: "phc_public",
    pathname: "/jobs/example-slug",
    origin: "https://jobappagent.com",
    referrer: leakyReferrer,
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.equal(result.ok, true);
  assert.equal(captured.length, 2);
  assert.equal(captured[0].body.properties.googleForJobs, true);
  assert.equal(captured[0].body.properties.jobsSource, JOBS_SOURCE_GOOGLE_FOR_JOBS);
  assert.equal("$referring_domain" in captured[0].body.properties, false);
  assert.equal(captured[1].body.event, JOBS_EVENTS.GOOGLE_FOR_JOBS_LANDING);
  assert.equal(captured[1].body.properties.jobsSource, JOBS_SOURCE_GOOGLE_FOR_JOBS);
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("jane"), false);
  assert.equal(serialized.includes("email%40"), false);
  assert.doesNotMatch(serialized, /\/search\?q=/);
  assert.doesNotMatch(serialized, /"\$referrer"/);
  assert.equal("$referrer" in captured[0].body.properties, false);
  assert.equal("referrer" in captured[0].body.properties, false);
  assertNoQueryOrReferrerLeak(serialized);
});

test("job-page pageview records the public slug path without query", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const result = await captureJobsPageview({
    apiKey: "phc_public",
    host: "https://us.i.posthog.com",
    pathname: "/jobs/example-labs-senior-backend-engineer-aaaaaaaaaaaaaaaa",
    search: "?utm_campaign=launch",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.event, "$pageview");
  assert.equal(captured[0].body.properties.surface, "job_page");
  assert.equal(
    captured[0].body.properties.$current_url,
    "https://jobappagent.com/jobs/example-labs-senior-backend-engineer-aaaaaaaaaaaaaaaa",
  );
  assert.equal("utm_campaign" in captured[0].body.properties, false);
  assert.equal("googleForJobs" in captured[0].body.properties, false);
  assert.equal(JSON.stringify(captured).includes("launch"), false);
});

test("google-for-jobs UTM landing fires once per document and omits paid clicks", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const fetchFn = fetchRecorder(captured);
  await captureJobsPageview({
    apiKey: "phc_public",
    pathname: "/jobs/example-slug",
    search: "?utm_source=google&utm_medium=organic",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn,
  });
  await captureJobsPageview({
    apiKey: "phc_public",
    pathname: "/jobs",
    search: "?utm_source=google&utm_medium=organic",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn,
  });
  const events = captured.map((row) => row.body.event);
  assert.deepEqual(events, ["$pageview", JOBS_EVENTS.GOOGLE_FOR_JOBS_LANDING, "$pageview"]);
  assert.equal(captured[0].body.properties.googleForJobs, true);
  assert.equal(captured[0].body.properties.jobsSource, JOBS_SOURCE_GOOGLE_FOR_JOBS);
  assert.equal("googleForJobs" in captured[2].body.properties, false);
  assert.equal("jobsSource" in captured[2].body.properties, false);
  assert.equal(JSON.stringify(captured).includes("utm_source"), false);

  resetJobsAnalyticsForTests();
  captured.length = 0;
  await captureJobsPageview({
    apiKey: "phc_public",
    pathname: "/jobs/example-slug",
    search: "?utm_source=google&utm_medium=cpc&gclid=abc",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.event, "$pageview");
  assert.equal("googleForJobs" in captured[0].body.properties, false);
  assert.equal(JSON.stringify(captured).includes("gclid"), false);
  assert.equal(JSON.stringify(captured).includes("abc"), false);

  resetJobsAnalyticsForTests();
  captured.length = 0;
  await captureJobsPageview({
    apiKey: "phc_public",
    pathname: "/jobs/example-slug",
    search: "?utm_source=google&utm_medium=paidsearch",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn,
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.event, "$pageview");
  assert.equal("googleForJobs" in captured[0].body.properties, false);
});

test("overlapping Google landings reserve the once-per-document flag before awaiting", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const fetchFn = async (url, options) => {
    await Promise.resolve();
    captured.push({ url, body: JSON.parse(String(options.body)) });
    return new Response("{}", { status: 200 });
  };
  const input = {
    apiKey: "phc_public",
    pathname: "/jobs/example-slug",
    search: "?utm_source=google&utm_medium=organic",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn,
  };
  await Promise.all([captureJobsPageview(input), captureJobsPageview(input)]);
  const landings = captured.filter((row) => row.body.event === JOBS_EVENTS.GOOGLE_FOR_JOBS_LANDING);
  assert.equal(landings.length, 1);
  assert.equal(captured.filter((row) => row.body.event === "$pageview").length, 2);
});

test("jobsCaptureHost pins browser ingest to same-origin /ingest", async () => {
  assert.equal(jobsCaptureHost(undefined), BROWSER_POSTHOG_INGEST_PATH);
  assert.equal(jobsCaptureHost(DEFAULT_POSTHOG_HOST), BROWSER_POSTHOG_INGEST_PATH);
  assert.equal(jobsCaptureHost("https://eu.i.posthog.com"), BROWSER_POSTHOG_INGEST_PATH);
  assert.equal(jobsCaptureHost("https://attacker.example"), BROWSER_POSTHOG_INGEST_PATH);

  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  await captureJobsPageview({
    apiKey: "phc_public",
    host: "https://eu.i.posthog.com",
    pathname: "/jobs",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, `${BROWSER_POSTHOG_INGEST_PATH}/i/v0/e/`);
});

test("alerts routes and missing surfaces skip capture", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const skipped = await captureJobsPageview({
    apiKey: "phc_public",
    pathname: "/jobs/alerts/confirm",
    search: "?token=secret",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.deepEqual(skipped, { ok: false, skipped: true });
  assert.equal(captured.length, 0);
});

test("copy clicks send copyKind only — never clipboard contents", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const prompt = "Apply to this role with JobAppAgent\nURL: https://boards.greenhouse.io/exampleco/jobs/1001";
  assert.equal(isJobsCopyKind(JOBS_COPY_KINDS.PROMPT), true);
  const result = await captureJobsCopyClicked({
    apiKey: "phc_public",
    copyKind: JOBS_COPY_KINDS.COMMAND,
    pathname: "/jobs/example-slug",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.equal(result.ok, true);
  assert.equal(captured[0].body.event, JOBS_EVENTS.COPY_CLICKED);
  assert.equal(captured[0].body.properties.copyKind, "command");
  assert.equal(captured[0].body.properties.surface, "job_page");
  assert.equal(captured[0].body.properties.$process_person_profile, false);
  assert.equal(captured[0].body.properties.$geoip_disable, true);
  assert.equal(JSON.stringify(captured).includes(prompt), false);
  assert.equal(JSON.stringify(captured).includes("writeText"), false);

  const skipped = await captureJobsCopyClicked({
    apiKey: "phc_public",
    // @ts-expect-error runtime guard
    copyKind: "resume",
    pathname: "/jobs/example-slug",
    origin: "https://jobappagent.com",
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.deepEqual(skipped, { ok: false, skipped: true });
  assert.equal(captured.length, 1);
});

test("classification reads allowlisted UTM locally and events get a derived label only", () => {
  resetJobsAnalyticsForTests();
  assert.deepEqual([...JOBS_UTM_KEYS], ["utm_source", "utm_medium", "utm_campaign"]);
  assert.deepEqual(
    readJobsUtmFromLocation("?utm_source=google_jobs_apply&utm_medium=organic&utm_campaign=google_jobs_apply&utm_term=engineer+email%40x.com&utm_content=hero&gclid=abc123&email=nope@example.com&workplace=remote"),
    {
      utm_source: "google_jobs_apply",
      utm_medium: "organic",
      utm_campaign: "google_jobs_apply",
    },
  );
  const leaky = "https://www.google.com/search?q=jane+doe+email%40x.com&secret-query=1";
  const attribution = jobsAttributionProperties({
    search: "?utm_source=google_jobs_apply&utm_medium=organic&utm_term=leak",
    referrer: leaky,
  });
  assert.deepEqual(attribution, { jobsSource: JOBS_SOURCE_GOOGLE_FOR_JOBS });
  assert.deepEqual(Object.keys(attribution), ["jobsSource"]);
  assertNoQueryOrReferrerLeak(JSON.stringify(attribution));
  assert.deepEqual(jobsAttributionProperties({
    search: "?utm_source=twitter&utm_medium=organic",
    referrer: leaky,
  }), {});
});

test("google_jobs_apply landing fires in parallel with pageview and keeps attribution private", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn = async (url, options) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    captured.push({ url, body: JSON.parse(String(options.body)) });
    inFlight -= 1;
    return new Response("{}", { status: 200 });
  };
  const leakyReferrer = "https://www.google.com/search?q=jane+doe+email%40x.com";
  const result = await captureJobsPageview({
    apiKey: "phc_public",
    pathname: "/jobs/example-slug",
    origin: "https://jobappagent.com",
    href: "https://jobappagent.com/jobs/example-slug?utm_source=google_jobs_apply&utm_medium=organic&utm_campaign=google_jobs_apply&utm_term=secret#top",
    search: "?utm_source=google_jobs_apply&utm_medium=organic&utm_campaign=google_jobs_apply&utm_term=secret&utm_content=ad&email=nope@example.com&workplace=remote",
    referrer: leakyReferrer,
    distinctId: DISTINCT,
    fetchFn,
  });
  assert.equal(result.ok, true);
  assert.equal(maxInFlight, 2);
  const events = captured.map((row) => row.body.event);
  assert.deepEqual(events, ["$pageview", JOBS_EVENTS.GOOGLE_FOR_JOBS_LANDING]);
  for (const row of captured) {
    assert.equal(row.body.properties.jobsSource, JOBS_SOURCE_GOOGLE_FOR_JOBS);
    assert.equal("utm_source" in row.body.properties, false);
    assert.equal("utm_medium" in row.body.properties, false);
    assert.equal("utm_campaign" in row.body.properties, false);
    assert.equal("$referring_domain" in row.body.properties, false);
    assert.equal(row.body.properties.$current_url, "https://jobappagent.com/jobs/example-slug");
    assert.equal(row.body.properties.$current_url.includes("?"), false);
    assert.equal(row.body.properties.$process_person_profile, false);
    assert.equal(row.body.properties.$geoip_disable, true);
    assert.equal(row.body.properties.$lib_custom_api_host, BROWSER_POSTHOG_INGEST_PATH);
    assert.equal("$referrer" in row.body.properties, false);
    assert.equal("gclid" in row.body.properties, false);
  }
  assert.equal(captured[0].body.properties.googleForJobs, true);
  assert.equal("googleForJobs" in captured[1].body.properties, false);
  assert.equal(captured[0].url, `${BROWSER_POSTHOG_INGEST_PATH}/i/v0/e/`);
  assertNoQueryOrReferrerLeak(JSON.stringify(captured));
});

test("first-touch search survives a later empty query string", async () => {
  resetJobsAnalyticsForTests();
  rememberJobsDocumentTouch({
    search: "?utm_source=google_jobs_apply&utm_medium=organic",
    referrer: "https://www.google.com/",
  });
  /** @type {unknown[]} */
  const captured = [];
  await captureJobsPageview({
    apiKey: "phc_public",
    pathname: "/jobs/example-slug",
    origin: "https://jobappagent.com",
    search: "",
    referrer: "",
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.equal(captured.length, 2);
  assert.equal(captured[0].body.properties.jobsSource, JOBS_SOURCE_GOOGLE_FOR_JOBS);
  assert.equal(captured[0].body.properties.googleForJobs, true);
  assert.equal("utm_source" in captured[0].body.properties, false);
  assert.equal("$referring_domain" in captured[0].body.properties, false);
  assert.equal(captured[1].body.event, JOBS_EVENTS.GOOGLE_FOR_JOBS_LANDING);
  assertNoQueryOrReferrerLeak(JSON.stringify(captured));
});

async function drainCopyClicks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("trackJobsCopyClicked reads window config so a split client chunk still fires", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    location: { pathname: "/jobs/example-slug", origin: "https://jobappagent.com" },
    [JOBS_ANALYTICS_WINDOW_KEY]: { apiKey: "phc_public", host: BROWSER_POSTHOG_INGEST_PATH },
  };
  globalThis.fetch = fetchRecorder(captured);
  try {
    trackJobsCopyClicked(JOBS_COPY_KINDS.PROMPT);
    await drainCopyClicks();
    assert.equal(captured.length, 1);
    assert.equal(captured[0].body.event, JOBS_EVENTS.COPY_CLICKED);
    assert.equal(captured[0].body.properties.copyKind, "prompt");
    assert.equal(captured[0].body.properties.surface, "job_page");
    assert.equal(captured[0].body.properties.$process_person_profile, false);
    assert.equal(captured[0].body.properties.$geoip_disable, true);
    assert.equal(captured[0].url, `${BROWSER_POSTHOG_INGEST_PATH}/i/v0/e/`);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
    resetJobsAnalyticsForTests();
  }
});

test("copy clicks queue on window until analytics config is ready then flush", async () => {
  resetJobsAnalyticsForTests();
  /** @type {unknown[]} */
  const captured = [];
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  globalThis.window = {
    location: { pathname: "/jobs/example-slug", origin: "https://jobappagent.com" },
  };
  globalThis.fetch = fetchRecorder(captured);
  try {
    trackJobsCopyClicked(JOBS_COPY_KINDS.COMMAND);
    await drainCopyClicks();
    assert.equal(captured.length, 0);
    setJobsAnalyticsBrowserConfig({ apiKey: "phc_public", host: BROWSER_POSTHOG_INGEST_PATH });
    await drainCopyClicks();
    assert.equal(captured.length, 1);
    assert.equal(captured[0].body.event, JOBS_EVENTS.COPY_CLICKED);
    assert.equal(captured[0].body.properties.copyKind, "command");
    assert.equal(captured[0].url, `${BROWSER_POSTHOG_INGEST_PATH}/i/v0/e/`);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
    resetJobsAnalyticsForTests();
  }
});

test("CopyButton tracks before clipboard write and JobDetail still passes copyKind", async () => {
  const button = await readFile(new URL("../app/jobs/CopyButton.tsx", import.meta.url), "utf8");
  const detail = await readFile(new URL("../app/jobs/JobDetail.tsx", import.meta.url), "utf8");
  const handler = button.slice(button.indexOf("onClick="));
  const trackAt = handler.indexOf("trackCopyKind(copyKind)");
  const clipboardAt = handler.indexOf("clipboard.writeText");
  assert.ok(trackAt >= 0, "CopyButton onClick must call trackCopyKind");
  assert.ok(clipboardAt >= 0, "CopyButton onClick must still write the clipboard");
  assert.ok(trackAt < clipboardAt, "jobs_copy_clicked must fire before clipboard I/O");
  assert.match(detail, /copyKind="prompt"/);
  assert.match(detail, /copyKind="command"/);
});
