import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAttentionMagicLinkUrl,
  signAttentionMagicLink,
  verifyAttentionMagicLink,
} from "../lib/attention-magic-link.mjs";
import { buildAttentionEmail, sendAttentionEmail } from "../lib/attention-mail.mjs";
import { notifyAttentionOpened, validateAttentionNotifyRequest } from "../lib/attention-notify.mjs";
import {
  ATTENTION_SIGNAL_ACTIONS,
  formatRunnerSignalPoll,
  validateAttentionSignalRequest,
} from "../lib/attention-signals.mjs";

const SECRET = "test-attention-magic-link-secret-32b";

test("signs and verifies an attention magic link within TTL", async () => {
  const signed = await signAttentionMagicLink({
    attentionId: "attention-abc",
    company: "LiveKit",
    role: "Forward Deployed Engineer",
    url: "https://jobs.ashbyhq.com/livekit/example",
    stage: "submission",
    blocker: "legal-attestation",
    requiredActions: ["review-legal", "complete-captcha"],
  }, SECRET, { now: 1_700_000_000, ttlSeconds: 2700 });

  assert.equal(signed.ok, true);
  assert.match(signed.token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

  const verified = await verifyAttentionMagicLink(signed.token, SECRET, {
    attentionId: "attention-abc",
    now: 1_700_000_000 + 60,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.payload.attentionId, "attention-abc");
  assert.equal(verified.payload.company, "LiveKit");
  assert.deepEqual(verified.payload.requiredActions, ["review-legal", "complete-captcha"]);

  const url = buildAttentionMagicLinkUrl("https://jobappagent.com", "attention-abc", signed.token);
  assert.match(url, /^https:\/\/jobappagent\.com\/attention\/attention-abc\?token=/);
});

test("rejects forged, mismatched, and expired magic links", async () => {
  const signed = await signAttentionMagicLink({
    attentionId: "attention-abc",
    company: "Acme",
    role: "Engineer",
    blocker: "captcha",
    requiredActions: ["complete-captcha"],
  }, SECRET, { now: 1_700_000_000, ttlSeconds: 60 });

  const forged = `${signed.token.slice(0, -4)}aaaa`;
  assert.equal((await verifyAttentionMagicLink(forged, SECRET, { now: 1_700_000_000 })).ok, false);

  assert.equal((await verifyAttentionMagicLink(signed.token, SECRET, {
    attentionId: "attention-other",
    now: 1_700_000_000,
  })).error, "token_mismatch");

  assert.equal((await verifyAttentionMagicLink(signed.token, SECRET, {
    attentionId: "attention-abc",
    now: 1_700_000_100,
  })).error, "token_expired");

  assert.equal((await signAttentionMagicLink({ attentionId: "x" }, "short")).ok, false);
});

test("buyer email asks only employer questions even in a mixed pause", () => {
  const email = buildAttentionEmail({
    company: "LiveKit", role: "Forward Deployed Engineer", blocker: "captcha",
    requiredActions: ["complete-captcha"],
    questions: [{ id: "why", prompt: "Why this company?" }],
    magicLinkUrl: "https://jobappagent.com/attention/attention-1?token=abc",
  });
  assert.equal(email.subject, "Needs your answer: LiveKit — Forward Deployed Engineer");
  assert.match(email.text, /Why this company/);
  assert.match(email.text, /Continue applying:/);
  assert.match(email.html, /Continue applying/);
  assert.doesNotMatch(email.text + email.html, /captcha|live session|live browser|try again|resume application|VNC/i);
  assert.equal(buildAttentionEmail({ blocker: "captcha" }), null);
});

test("sendAttentionEmail fails closed without API key or on upstream error", async () => {
  const logs = [];
  const missing = await sendAttentionEmail({
    to: "candidate@example.com",
    company: "Acme",
    role: "Eng",
    blocker: "judgment",
    requiredActions: ["provide-judgment"],
    questions: [{ id: "why", prompt: "Why this company?", required: true }],
    magicLinkUrl: "https://jobappagent.com/attention/a?token=t",
  }, { apiKey: "", logger: { error: (message) => logs.push(message) } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "mailer_unconfigured");
  assert.match(logs.join("\n"), /fail-closed/);

  const upstream = await sendAttentionEmail({
    to: "candidate@example.com",
    company: "Acme",
    role: "Eng",
    blocker: "judgment",
    requiredActions: ["provide-judgment"],
    questions: [{ id: "why", prompt: "Why this company?", required: true }],
    magicLinkUrl: "https://jobappagent.com/attention/a?token=t",
  }, {
    apiKey: "re_test",
    logger: { error: () => {} },
    fetchImpl: async () => new Response("nope", { status: 500 }),
  });
  assert.equal(upstream.ok, false);
  assert.equal(upstream.error, "mailer_failed");
});

test("notifyAttentionOpened signs a link and sends mail when configured", async () => {
  const validated = validateAttentionNotifyRequest({
    attentionId: "attention-1",
    email: "candidate@example.com",
    company: "LiveKit",
    role: "FDE",
    blocker: "judgment",
    requiredActions: ["provide-judgment"],
    questions: [{ id: "why", prompt: "Why this company?", required: true }],
  });
  assert.equal(validated.ok, true);

  let sentBody = null;
  const result = await notifyAttentionOpened(validated.data, {
    magicLinkSecret: SECRET,
    publicSiteUrl: "https://jobappagent.com",
    resendApiKey: "re_test",
    logger: { error: () => {} },
    fetchImpl: async (_url, init) => {
      sentBody = JSON.parse(init.body);
      return Response.json({ id: "email_123" });
    },
  });
  assert.equal(result.ok, true);
  assert.match(result.magicLinkUrl, /\/attention\/attention-1\?token=/);
  assert.equal(sentBody.subject, "Needs your answer: LiveKit — FDE");
  assert.match(sentBody.text, /Continue applying:/);
});

test("notifyAttentionOpened fails closed without magic secret or mailer", async () => {
  const base = {
    attentionId: "attention-1",
    email: "candidate@example.com",
    company: "LiveKit",
    role: "FDE",
    blocker: "judgment",
    requiredActions: ["provide-judgment"],
    questions: [{ id: "why", prompt: "Why this company?", required: true }],
  };
  const noSecret = await notifyAttentionOpened(base, {
    magicLinkSecret: "",
    publicSiteUrl: "https://jobappagent.com",
    resendApiKey: "re_test",
    logger: { error: () => {} },
  });
  assert.equal(noSecret.ok, false);
  assert.equal(noSecret.error, "magic_link_unconfigured");

  const noMailer = await notifyAttentionOpened(base, {
    magicLinkSecret: SECRET,
    publicSiteUrl: "https://jobappagent.com",
    resendApiKey: "",
    logger: { error: () => {} },
  });
  assert.equal(noMailer.ok, false);
  assert.equal(noMailer.error, "mailer_unconfigured");
});

test("validates resume/skip/abort signals and runner poll shape", () => {
  assert.equal(validateAttentionSignalRequest({ token: "t", action: "resume" }).data.signal, ATTENTION_SIGNAL_ACTIONS.resume_requested);
  assert.equal(validateAttentionSignalRequest({ token: "t", action: "skip" }).data.signal, ATTENTION_SIGNAL_ACTIONS.skipped);
  assert.equal(validateAttentionSignalRequest({ token: "t", action: "abort" }).data.signal, ATTENTION_SIGNAL_ACTIONS.aborted);
  assert.equal(validateAttentionSignalRequest({ token: "", action: "resume" }).ok, false);

  const empty = formatRunnerSignalPoll(null);
  assert.equal(empty.resumeRequested, false);
  assert.equal(empty.pending, false);

  const poll = formatRunnerSignalPoll({
    attentionId: "attention-1",
    signal: "resume_requested",
    updatedAt: "2026-09-16T00:00:00.000Z",
  });
  assert.equal(poll.resumeRequested, true);
  assert.equal(poll.skipped, false);
});

test("technical-only pauses record ops stub immediately without mail, magic links or network", async () => {
  const logs = [];
  for (const blocker of ["captcha", "unsolvable", "live-required", "session-lost", "site-error", "judgment"]) {
    const result = await notifyAttentionOpened({
      attentionId: "attention-ops", company: "Acme", role: "Engineer", blocker,
      requiredActions: ["complete-captcha"],
    }, {
      logger: { warn: (message) => logs.push(message) },
      fetchImpl: () => { throw new Error("must not send"); },
    });
    assert.equal(result.ok, true);
    assert.equal(result.buyerNotified, false);
    assert.equal(result.adminAlert.status, "stubbed");
    assert.equal(result.adminAlert.buyerState, "in_progress");
    assert.equal(result.magicLinkUrl, undefined);
  }
  assert.equal(logs.length, 6);
  assert.doesNotMatch(logs.join(""), /candidate@|token|password|Acme|Engineer/);
});

test("mixed pause alerts ops before buyer mail configuration can fail", async () => {
  const logs = [];
  const result = await notifyAttentionOpened({
    attentionId: "attention-mixed", email: "candidate@example.com", company: "Acme", role: "Engineer",
    blocker: "captcha", requiredActions: ["complete-captcha", "provide-judgment"],
    questions: [{ id: "why", prompt: "Why this company?" }],
  }, { logger: { warn: (message) => logs.push(message), error: () => {} } });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /attention_admin_alert/);
  assert.equal(result.error, "magic_link_unconfigured");
});
