import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeRateLimit,
  hashRateLimitKey,
  publicSecurityHeaders,
  readJsonRequest,
  readTextRequest,
} from "../lib/public-boundary.mjs";

function rateLimitDatabase() {
  let count = 0;
  return {
    prepare(sql) {
      return {
        bind() {
          return {
            first: async () => sql.includes("RETURNING count") ? { count: ++count, windowStart: Math.floor(Date.now() / 1000) } : null,
            run: async () => ({ success: true }),
          };
        },
      };
    },
  };
}

test("reads bounded JSON even when content-length is omitted", async () => {
  const valid = await readJsonRequest(new Request("https://jobappagent.com/api/founding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "founder@example.com" }),
  }), 128);
  assert.deepEqual(valid, { ok: true, data: { email: "founder@example.com" } });

  const oversized = await readJsonRequest(new Request("https://jobappagent.com/api/founding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(256) }),
  }), 128);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.status, 413);
});

test("rejects unsupported and malformed request bodies", async () => {
  const unsupported = await readJsonRequest(new Request("https://jobappagent.com/api/founding", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
  }), 128);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.status, 415);

  const malformed = await readJsonRequest(new Request("https://jobappagent.com/api/founding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  }), 128);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.status, 400);
});

test("bounds webhook text even when content-length is omitted", async () => {
  const accepted = await readTextRequest(new Request("https://example.test", { method: "POST", body: "event" }), 5);
  assert.deepEqual(accepted, { ok: true, data: "event" });
  const rejected = await readTextRequest(new Request("https://example.test", { method: "POST", body: "too large" }), 5);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 413);
});

test("sets a restrictive browser security baseline", () => {
  const headers = publicSecurityHeaders();
  assert.match(headers["content-security-policy"], /default-src 'self'/);
  assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "strict-origin-when-cross-origin");
});

test("rate-limit keys do not retain a raw visitor address", async () => {
  const first = await hashRateLimitKey("203.0.113.42", "founding", "test-salt");
  const second = await hashRateLimitKey("203.0.113.42", "checkout", "test-salt");
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(first, /203\.0\.113\.42/);
  assert.notEqual(first, second);
});

test("throttles a visitor after the public endpoint allowance", async () => {
  const db = rateLimitDatabase();
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = await consumeRateLimit(db, "visitor-key", { limit: 10, windowSeconds: 900, now: 1_787_085_000 });
    assert.equal(result.allowed, true, `attempt ${attempt} should be allowed`);
  }
  const limited = await consumeRateLimit(db, "visitor-key", { limit: 10, windowSeconds: 900, now: 1_787_085_000 });
  assert.equal(limited.allowed, false);
  assert.ok(limited.retryAfter > 0);
});
