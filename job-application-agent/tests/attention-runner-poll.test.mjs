import assert from "node:assert/strict";
import test from "node:test";

import {
  EXIT,
  buildSignalPollUrl,
  interpretPoll,
  parseArgs,
  pollAttentionSignal,
  resolvePollConfig,
} from "../scripts/attention-runner-poll.mjs";

test("runner poll interprets resume/skip/abort with stable exit codes", () => {
  assert.equal(interpretPoll({ resumeRequested: true, signal: "resume_requested" }).exitCode, EXIT.RESUME);
  assert.equal(interpretPoll({ skipped: true, signal: "skipped" }).exitCode, EXIT.SKIPPED);
  assert.equal(interpretPoll({ aborted: true, signal: "aborted" }).exitCode, EXIT.ABORTED);
  assert.equal(interpretPoll({ signal: null, pending: false }).done, false);
  assert.match(interpretPoll({ resumeRequested: true }).message, /visible confirmation/i);
});

test("resolvePollConfig derives site origin from notify URL", () => {
  const cfg = resolvePollConfig({
    ATTENTION_NOTIFY_SECRET: "secret",
    ATTENTION_NOTIFY_URL: "https://jobappagent.com/api/internal/attention-notify",
  });
  assert.equal(cfg.siteUrl, "https://jobappagent.com");
  assert.equal(
    buildSignalPollUrl(cfg.siteUrl, "attention-1"),
    "https://jobappagent.com/api/internal/attention-signals/attention-1",
  );
});

test("parseArgs reads attention id, interval, timeout, once", () => {
  const args = parseArgs(["--attention-id", "attention-x", "--interval", "3", "--timeout", "30", "--once"]);
  assert.equal(args.attentionId, "attention-x");
  assert.equal(args.intervalSec, 3);
  assert.equal(args.timeoutSec, 30);
  assert.equal(args.once, true);
});

test("pollAttentionSignal returns resume exit code and next-action message", async () => {
  let calls = 0;
  const result = await pollAttentionSignal({
    attentionId: "attention-1",
    siteUrl: "https://jobappagent.com",
    secret: "test-secret",
    intervalSec: 1,
    timeoutSec: 10,
    log: () => {},
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({
          attentionId: "attention-1",
          signal: null,
          pending: false,
          resumeRequested: false,
          skipped: false,
          aborted: false,
        });
      }
      return Response.json({
        attentionId: "attention-1",
        signal: "resume_requested",
        pending: true,
        resumeRequested: true,
        skipped: false,
        aborted: false,
        updatedAt: "2026-09-16T00:00:00.000Z",
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, EXIT.RESUME);
  assert.equal(result.action, "resume");
  assert.match(result.message, /renew cloud lease/i);
});

test("pollAttentionSignal fails closed without secret or on 401", async () => {
  const missing = await pollAttentionSignal({
    attentionId: "attention-1",
    siteUrl: "https://jobappagent.com",
    secret: "",
    log: () => {},
  });
  assert.equal(missing.exitCode, EXIT.ERROR);

  const unauthorized = await pollAttentionSignal({
    attentionId: "attention-1",
    siteUrl: "https://jobappagent.com",
    secret: "bad",
    once: true,
    log: () => {},
    fetchImpl: async () => new Response("nope", { status: 401 }),
  });
  assert.equal(unauthorized.exitCode, EXIT.ERROR);
  assert.match(unauthorized.error, /unauthorized/i);
});

test("pollAttentionSignal exits skipped and aborted", async () => {
  const skipped = await pollAttentionSignal({
    attentionId: "attention-1",
    siteUrl: "https://jobappagent.com",
    secret: "s",
    once: true,
    log: () => {},
    fetchImpl: async () => Response.json({
      attentionId: "attention-1",
      signal: "skipped",
      pending: true,
      resumeRequested: false,
      skipped: true,
      aborted: false,
    }),
  });
  assert.equal(skipped.exitCode, EXIT.SKIPPED);

  const aborted = await pollAttentionSignal({
    attentionId: "attention-1",
    siteUrl: "https://jobappagent.com",
    secret: "s",
    once: true,
    log: () => {},
    fetchImpl: async () => Response.json({
      attentionId: "attention-1",
      signal: "aborted",
      pending: true,
      resumeRequested: false,
      skipped: false,
      aborted: true,
    }),
  });
  assert.equal(aborted.exitCode, EXIT.ABORTED);
});
