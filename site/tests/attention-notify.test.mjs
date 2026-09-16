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

test("builds attention email with checklist and Open live session CTA", () => {
  const email = buildAttentionEmail({
    company: "LiveKit",
    role: "Forward Deployed Engineer",
    blocker: "legal-attestation",
    requiredActions: ["review-legal", "provide-judgment", "complete-captcha"],
    magicLinkUrl: "https://jobappagent.com/attention/attention-1?token=abc",
  });
  assert.equal(email.subject, "Action needed: LiveKit — Forward Deployed Engineer");
  assert.match(email.text, /Required actions:/);
  assert.match(email.text, /- Review legal attestation/);
  assert.match(email.text, /Open live session: https:\/\/jobappagent\.com\/attention\/attention-1\?token=abc/);
  assert.match(email.html, /Open live session/);
  assert.match(email.text, /does not include any VNC password/);
  assert.doesNotMatch(email.text, /vnc password:\s*\S+/i);
});

test("sendAttentionEmail fails closed without API key or on upstream error", async () => {
  const logs = [];
  const missing = await sendAttentionEmail({
    to: "candidate@example.com",
    company: "Acme",
    role: "Eng",
    blocker: "captcha",
    requiredActions: ["complete-captcha"],
    magicLinkUrl: "https://jobappagent.com/attention/a?token=t",
  }, { apiKey: "", logger: { error: (message) => logs.push(message) } });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "mailer_unconfigured");
  assert.match(logs.join("\n"), /fail-closed/);

  const upstream = await sendAttentionEmail({
    to: "candidate@example.com",
    company: "Acme",
    role: "Eng",
    blocker: "captcha",
    requiredActions: ["complete-captcha"],
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
    blocker: "captcha",
    requiredActions: ["complete-captcha"],
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
  assert.equal(sentBody.subject, "Action needed: LiveKit — FDE");
  assert.match(sentBody.text, /Open live session:/);
});

test("notifyAttentionOpened fails closed without magic secret or mailer", async () => {
  const base = {
    attentionId: "attention-1",
    email: "candidate@example.com",
    company: "LiveKit",
    role: "FDE",
    blocker: "captcha",
    requiredActions: ["complete-captcha"],
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
