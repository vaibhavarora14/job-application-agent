import assert from "node:assert/strict";
import test from "node:test";

import worker, { sha256Hex } from "../src/worker.mjs";
import { createMemoryR2 } from "./r2-mock.mjs";

const TOKEN = "test-state-token-with-sufficient-length";

function env(token = TOKEN) {
  return {
    STATE_TOKEN: token,
    STATE: createMemoryR2(),
  };
}

function request(path, { method = "GET", token = TOKEN, body, headers = {} } = {}) {
  const nextHeaders = { ...headers };
  if (token !== null) nextHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined && !nextHeaders["content-type"]) {
    nextHeaders["content-type"] = "application/json";
  }
  return new Request(`https://state.example.com${path}`, {
    method,
    headers: nextHeaders,
    body,
  });
}

test("401 without token", async () => {
  const bindings = env();
  for (const path of [
    "/v1/manifest",
    "/v1/files/resume.json",
    "/v1/profile",
    "/v1/ledgers/applications.ndjson",
  ]) {
    const response = await worker.fetch(request(path, { token: null }), bindings);
    assert.equal(response.status, 401);
  }
});

test("PUT then GET file", async () => {
  const bindings = env();
  const body = JSON.stringify({ source: "local" });
  const put = await worker.fetch(
    request("/v1/files/resume.json", { method: "PUT", body }),
    bindings,
  );
  assert.equal(put.status, 201);
  const stored = await put.json();
  assert.equal(stored.name, "resume.json");
  assert.match(stored.sha256, /^[0-9a-f]{64}$/);

  const get = await worker.fetch(request("/v1/files/resume.json"), bindings);
  assert.equal(get.status, 200);
  assert.equal(await get.text(), body);
  assert.equal(get.headers.get("x-sha256"), stored.sha256);
});

test("If-Match 412 on mismatch", async () => {
  const bindings = env();
  await worker.fetch(
    request("/v1/files/autonomy.json", {
      method: "PUT",
      body: '{"mode":"review-each"}',
    }),
    bindings,
  );
  const conflict = await worker.fetch(
    request("/v1/files/autonomy.json", {
      method: "PUT",
      body: '{"mode":"auto"}',
      headers: { "if-match": "wrong-etag" },
    }),
    bindings,
  );
  assert.equal(conflict.status, 412);
});

test("ledger append concatenates", async () => {
  const bindings = env();
  const first = await worker.fetch(
    request("/v1/ledgers/applications.ndjson", {
      method: "POST",
      body: JSON.stringify({ lines: ['{"id":"a1"}'] }),
    }),
    bindings,
  );
  assert.equal(first.status, 200);

  const second = await worker.fetch(
    request("/v1/ledgers/applications.ndjson", {
      method: "POST",
      body: JSON.stringify({ lines: ['{"id":"a2"}'] }),
    }),
    bindings,
  );
  assert.equal(second.status, 200);

  const file = await worker.fetch(request("/v1/files/applications.ndjson"), bindings);
  const text = await file.text();
  assert.equal(text, '{"id":"a1"}\n{"id":"a2"}\n');
});

test("profile roundtrip", async () => {
  const bindings = env();
  const profile = { name: "Ada Lovelace", email: "ada@example.com" };
  const put = await worker.fetch(
    request("/v1/profile", { method: "PUT", body: JSON.stringify(profile) }),
    bindings,
  );
  assert.equal(put.status, 201);

  const get = await worker.fetch(request("/v1/profile"), bindings);
  assert.deepEqual(await get.json(), profile);
});

test("rejected password key", async () => {
  const bindings = env();
  const response = await worker.fetch(
    request("/v1/profile", {
      method: "PUT",
      body: JSON.stringify({ name: "Ada", password: "secret" }),
    }),
    bindings,
  );
  assert.equal(response.status, 400);
});

test("GET /healthz returns ok", async () => {
  const bindings = env();
  const response = await worker.fetch(request("/healthz"), bindings);
  assert.deepEqual(await response.json(), { ok: true });
});

test("manifest lists stored files", async () => {
  const bindings = env();
  const body = '{"ok":true}';
  await worker.fetch(
    request("/v1/files/telemetry.json", { method: "PUT", body }),
    bindings,
  );
  const manifest = await worker.fetch(request("/v1/manifest"), bindings);
  const entries = await manifest.json();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "telemetry.json");
  assert.equal(entries[0].sha256, sha256Hex(Buffer.from(body)));
});
