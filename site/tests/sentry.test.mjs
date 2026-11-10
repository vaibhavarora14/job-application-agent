import assert from "node:assert/strict";
import test from "node:test";
import {
  SITE_SENTRY_SERVICE,
  SITE_WORKER_NAME,
  isSiteVersionPreviewHost,
  resolveSentryEnvironment,
  shouldReportSiteSentryForUrl,
  siteSentryOptions,
} from "../lib/sentry-options.mjs";

test("siteSentryOptions is disabled when SENTRY_DSN is missing", () => {
  assert.equal(siteSentryOptions({}), undefined);
  assert.equal(siteSentryOptions({ SENTRY_DSN: "   " }), undefined);
});

test("siteSentryOptions reads DSN from env and tags service site", () => {
  const options = siteSentryOptions({
    SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
    PUBLIC_SITE_URL: "https://jobappagent.com",
    SENTRY_RELEASE: "abc123def",
  });
  assert.ok(options);
  assert.equal(options.dsn, "https://examplePublicKey@o0.ingest.sentry.io/0");
  assert.equal(options.environment, "production");
  assert.equal(options.release, "abc123def");
  assert.equal(options.tracesSampleRate, 0);
  assert.equal(options.initialScope?.tags?.service, SITE_SENTRY_SERVICE);
  assert.equal(options.dataCollection?.userInfo, false);
  assert.deepEqual(options.dataCollection?.httpBodies, []);
});

test("siteSentryOptions omits release when SENTRY_RELEASE is unset", () => {
  const options = siteSentryOptions({
    SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
  });
  assert.ok(options);
  assert.equal("release" in options, false);
});

test("version-preview workers.dev hosts are not reported; production hosts are", () => {
  const preview = "https://69892e0a-job-application-agent-site.varora1406.workers.dev/api/community-stats";
  const alias = "https://staging-job-application-agent-site.varora1406.workers.dev/api/community-stats";
  const mainWorker = "https://job-application-agent-site.varora1406.workers.dev/api/community-stats";
  const apex = "https://jobappagent.com/api/community-stats";
  const stats = "https://stats.jobappagent.com/api/community-stats";

  assert.equal(isSiteVersionPreviewHost(preview), true);
  assert.equal(isSiteVersionPreviewHost(alias), true);
  assert.equal(isSiteVersionPreviewHost("69892E0A-job-application-agent-site.varora1406.workers.dev."), true);
  assert.equal(shouldReportSiteSentryForUrl(preview), false);
  assert.equal(shouldReportSiteSentryForUrl(alias), false);

  assert.equal(isSiteVersionPreviewHost(mainWorker), false);
  assert.equal(isSiteVersionPreviewHost(apex), false);
  assert.equal(isSiteVersionPreviewHost("https://job-application-agent-site.evil.example/api/community-stats"), false);
  assert.equal(isSiteVersionPreviewHost("https://69892e0a-other-worker.varora1406.workers.dev/api/community-stats"), false);
  assert.equal(shouldReportSiteSentryForUrl(mainWorker), true);
  assert.equal(shouldReportSiteSentryForUrl(apex), true);
  assert.equal(shouldReportSiteSentryForUrl(stats), true);
  assert.equal(shouldReportSiteSentryForUrl("http://localhost:3000/api/community-stats"), true);
  assert.equal(shouldReportSiteSentryForUrl(undefined), true);
  assert.equal(shouldReportSiteSentryForUrl(""), true);
  assert.equal(shouldReportSiteSentryForUrl("not a url"), true);

  const options = siteSentryOptions({
    SENTRY_DSN: "https://examplePublicKey@o0.ingest.sentry.io/0",
    PUBLIC_SITE_URL: "https://jobappagent.com",
  });
  assert.equal(options?.environment, "production");
  const previewEvent = { request: { url: preview }, message: "API 503 GET /api/community-stats" };
  const productionEvent = { request: { url: mainWorker }, message: "API 503 GET /api/community-stats" };
  assert.equal(options?.beforeSend?.(previewEvent), null);
  assert.equal(options?.beforeSend?.({ tags: { url: alias } }), null);
  assert.equal(options?.beforeSend?.({ request: { url: "/api/community-stats" }, tags: { url: preview } }), null);
  assert.equal(options?.beforeSend?.(productionEvent), productionEvent);
  assert.equal(options?.beforeSend?.({ message: "no request url" })?.message, "no request url");
});

test("SITE_WORKER_NAME matches the site Worker name", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const match = text.match(/"name"\s*:\s*"([^"]+)"/);
  assert.equal(match?.[1], SITE_WORKER_NAME);
});

test("resolveSentryEnvironment prefers explicit override and parses hostnames", () => {
  assert.equal(
    resolveSentryEnvironment({
      SENTRY_ENVIRONMENT: "staging",
      PUBLIC_SITE_URL: "https://jobappagent.com",
    }),
    "staging",
  );
  assert.equal(
    resolveSentryEnvironment({ PUBLIC_SITE_URL: "https://jobappagent.com" }),
    "production",
  );
  assert.equal(
    resolveSentryEnvironment({ PUBLIC_SITE_URL: "https://stats.jobappagent.com" }),
    "production",
  );
  assert.equal(
    resolveSentryEnvironment({ PUBLIC_SITE_URL: "http://localhost:3000" }),
    "development",
  );
  // Substring spoof must not count as production.
  assert.equal(
    resolveSentryEnvironment({ PUBLIC_SITE_URL: "https://evil-jobappagent.com.example" }),
    "development",
  );
});

test("source and docs never embed a committed Sentry DSN value", async () => {
  const { readFile } = await import("node:fs/promises");
  const files = [
    new URL("../lib/sentry.mjs", import.meta.url),
    new URL("../lib/sentry-options.mjs", import.meta.url),
    new URL("../worker/index.ts", import.meta.url),
    new URL("../README.md", import.meta.url),
    new URL("../docs/SENTRY.md", import.meta.url),
    new URL("../.env.example", import.meta.url),
  ];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    assert.doesNotMatch(text, /SENTRY_DSN\s*=\s*https:\/\//);
    // Hex-key DSN shape used by Sentry — allow placeholder keys like "examplePublicKey" in tests only.
    assert.doesNotMatch(text, /https:\/\/[a-f0-9]{20,}@o\d+\.ingest\.sentry\.io\/\d+/i);
  }
});
