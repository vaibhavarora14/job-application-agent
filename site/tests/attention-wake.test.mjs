import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAttentionWakePayload,
  defaultWakeInstructions,
  dispatchAttentionWake,
  formatWakeStatusMessage,
  validateAttentionWakeRequest,
} from "../lib/attention-wake.mjs";

test("validateAttentionWakeRequest accepts attention id and defaults", () => {
  const ok = validateAttentionWakeRequest({ attentionId: "attention-1" });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.attentionId, "attention-1");
  assert.equal(ok.data.reason, "live_session");
  assert.equal(ok.data.source, "internal");

  const bad = validateAttentionWakeRequest({});
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 400);
});

test("buildAttentionWakePayload is stable for webhook consumers", () => {
  const payload = buildAttentionWakePayload({
    attentionId: "attention-9",
    reason: "live_session",
    source: "attention_page",
    now: "2026-09-16T00:00:00.000Z",
  });
  assert.deepEqual(payload, {
    type: "attention_wake",
    attentionId: "attention-9",
    reason: "live_session",
    source: "attention_page",
    requestedAt: "2026-09-16T00:00:00.000Z",
  });
});

test("dispatchAttentionWake records instructions when wake URL unset", async () => {
  const result = await dispatchAttentionWake({
    attentionId: "attention-2",
    source: "ops",
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "recorded");
  assert.match(result.message, /Starting live browser/);
  assert.match(result.instructions, /gcloud compute instances start/);
  assert.match(defaultWakeInstructions(), /agent-box/);
});

test("dispatchAttentionWake posts webhook when ATTENTION_WAKE_URL set", async () => {
  /** @type {RequestInit | undefined} */
  let seen;
  const result = await dispatchAttentionWake({
    attentionId: "attention-3",
    wakeUrl: "https://wake.example/start",
    notifySecret: "secret",
    fetchImpl: async (_url, init) => {
      seen = init;
      return new Response("ok", { status: 200 });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, "dispatched");
  assert.equal(result.instructions, null);
  assert.equal(seen?.method, "POST");
  assert.equal(seen?.headers?.authorization, "Bearer secret");
  const body = JSON.parse(String(seen?.body));
  assert.equal(body.type, "attention_wake");
  assert.equal(body.attentionId, "attention-3");
});

test("dispatchAttentionWake fails closed on webhook error", async () => {
  const result = await dispatchAttentionWake({
    attentionId: "attention-4",
    wakeUrl: "https://wake.example/start",
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "wake_dispatch_failed");
  assert.match(result.message, /Wake signal failed/);
  assert.match(formatWakeStatusMessage("starting"), /Starting live browser/);
});
