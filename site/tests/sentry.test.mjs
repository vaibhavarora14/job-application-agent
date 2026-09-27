import assert from "node:assert/strict";
import test from "node:test";
import {
  SITE_SENTRY_SERVICE,
  resolveSentryEnvironment,
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
