import assert from "node:assert/strict";
import test from "node:test";

import {
  JOBS_COPY_KINDS,
  JOBS_EVENTS,
  captureJobsCopyClicked,
  captureJobsPageview,
  classifyJobsSurface,
  detectGoogleForJobsLanding,
  isGoogleJobsReferrerHost,
  isJobsCopyKind,
  jobsCaptureUrl,
  normalizeJobsPathname,
  referrerHostname,
  resetJobsAnalyticsForTests,
} from "../lib/jobs-analytics.mjs";

const DISTINCT = "11111111-1111-4111-8111-111111111111";

/** @param {unknown[]} captured */
function fetchRecorder(captured) {
  return async (url, options) => {
    captured.push({ url, body: JSON.parse(String(options.body)) });
    return new Response("{}", { status: 200 });
  };
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
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=google&utm_medium=cpc" }), false);
  assert.equal(detectGoogleForJobsLanding({
    referrer: leakyReferrer,
    search: "?gclid=abc123",
  }), false);
  assert.equal(detectGoogleForJobsLanding({ search: "?utm_source=twitter" }), false);
  assert.equal(detectGoogleForJobsLanding({
    referrer: leakyReferrer,
    search: "?utm_source=twitter",
  }), false);
  assert.equal(detectGoogleForJobsLanding({ referrer: "https://t.co/x" }), false);
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
    referrer: "https://t.co/x?q=secret-query",
    distinctId: DISTINCT,
    fetchFn: fetchRecorder(captured),
  });
  assert.equal(result.ok, true);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].body.event, "$pageview");
  assert.equal(captured[0].body.properties.surface, "board");
  assert.equal(captured[0].body.properties.$pathname, "/jobs");
  assert.equal(captured[0].body.properties.$current_url, "https://jobappagent.com/jobs");
  assert.equal(captured[0].body.properties.utm_source, "twitter");
  assert.equal("googleForJobs" in captured[0].body.properties, false);
  assert.equal(captured[0].body.properties.$process_person_profile, false);
  assert.equal(captured[0].body.properties.$geoip_disable, true);
  assert.deepEqual(
    Object.keys(captured[0].body.properties).sort(),
    ["$current_url", "$geoip_disable", "$pathname", "$process_person_profile", "path", "surface", "utm_source"].sort(),
  );
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("workplace=remote"), false);
  assert.equal(serialized.includes("secret-query"), false);
  assert.equal(serialized.includes("nope@example.com"), false);
  assert.equal(serialized.includes("$referrer"), false);
  assert.equal(serialized.includes("https://t.co"), false);
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
  assert.equal(captured[1].body.event, JOBS_EVENTS.GOOGLE_FOR_JOBS_LANDING);
  const serialized = JSON.stringify(captured);
  assert.equal(serialized.includes("jane"), false);
  assert.equal(serialized.includes("email%40"), false);
  assert.equal(serialized.includes("google.com/search"), false);
  assert.equal(serialized.includes("$referrer"), false);
  assert.equal("$referrer" in captured[0].body.properties, false);
  assert.equal("referrer" in captured[0].body.properties, false);
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
  assert.equal(captured[0].body.properties.utm_campaign, "launch");
  assert.equal("googleForJobs" in captured[0].body.properties, false);
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
  assert.equal("googleForJobs" in captured[2].body.properties, false);

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
