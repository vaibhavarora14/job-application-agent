import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { signAttentionMagicLink } from "../lib/attention-magic-link.mjs";

const secret = "test-only-attention-route-secret";
const folder = await mkdtemp(new URL("../node_modules/.attention-route-", import.meta.url));
let POST, savedRecords;
try {
  const outfile = path.join(folder, "signal.mjs");
  await build({
    stdin: {
      contents: 'export { POST } from "./app/api/attention/[id]/signal/route.ts"; export { savedRecords } from "./lib/attention-signal-store.ts";',
      resolveDir: new URL("../", import.meta.url).pathname,
    },
    outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "local-boundaries", setup(builder) {
      builder.onLoad({ filter: /attention-auth\.ts$/ }, () => ({ contents: `export const attentionEnv = () => ({ magicLinkSecret: ${JSON.stringify(secret)} });`, loader: "js" }));
      builder.onLoad({ filter: /attention-signal-store\.ts$/ }, () => ({ contents: 'export const savedRecords = []; export async function upsertAttentionSignal(record) { savedRecords.push(record); return { ...record, updatedAt: "test" }; }', loader: "js" }));
      builder.onLoad({ filter: /attention-answer-bank\.ts$/ }, () => ({ contents: 'export async function upsertAnswerBankEntries() {}', loader: "js" }));
    } }],
  });
  ({ POST, savedRecords } = await import(pathToFileURL(outfile)));
} finally { await rm(folder, { recursive: true, force: true }); }

async function signal(token, answers, action = "resume") {
  return POST(new Request("http://localhost/api/attention/test/signal", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, action, answers }),
  }), { params: Promise.resolve({ id: "test" }) });
}

test("signal route enforces token and required answers before storing coordination", async () => {
  const signed = await signAttentionMagicLink({ attentionId: "test", company: "Acme", role: "Engineer", questions: [{ id: "why", prompt: "Why this company?", required: true }] }, secret);
  assert.equal((await signal("design-fixture", [])).status, 401);
  for (const answers of [[], [{ questionId: "why", text: " \n\t " }], [{ questionId: "unknown", text: "Answer" }]]) {
    assert.equal((await signal(signed.token, answers)).status, 400);
  }
  assert.equal(savedRecords.length, 0);
  const response = await signal(signed.token, [{ questionId: "why", text: "Relevant experience" }]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).signal, "resume_requested");
  assert.equal(savedRecords.length, 1);
  assert.equal(savedRecords[0].payload.answers[0].text, "Relevant experience");
});

test("technical-only tokens cannot signal buyer resume; skip remains available", async () => {
  const signed = await signAttentionMagicLink({ attentionId: "test", blocker: "captcha", requiredActions: ["complete-captcha"] }, secret);
  assert.equal((await signal(signed.token, [])).status, 400);
  const response = await signal(signed.token, [], "skip");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).signal, "skipped");
});
