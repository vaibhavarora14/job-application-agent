import assert from "node:assert/strict";
import test from "node:test";

import {
  buildLiveSessionProxyPath,
  buildLiveSessionProxyUrl,
  buildNoVncLiveSessionUrl,
  defaultIapHelperCommand,
  liveBrowserUnavailableMessage,
  liveSessionFrameSrcOrigins,
  resolveLiveSessionTarget,
  wantsLiveSessionEmbed,
} from "../lib/attention-live-session.mjs";

test("builds noVNC URL with autoconnect and password in fragment only", () => {
  const built = buildNoVncLiveSessionUrl("https://agent-box.example:6080/vnc.html", {
    attentionId: "attention-1",
    password: "secret-vnc",
  });
  assert.equal(built.ok, true);
  const url = new URL(built.url);
  assert.equal(url.searchParams.get("autoconnect"), "true");
  assert.equal(url.searchParams.get("attention"), "attention-1");
  assert.equal(url.searchParams.has("password"), false);
  assert.match(url.hash, /password=secret-vnc/);
});

test("rejects invalid live-session base URL", () => {
  assert.equal(buildNoVncLiveSessionUrl("").ok, false);
  assert.equal(buildNoVncLiveSessionUrl("not a url").ok, false);
});

test("resolveLiveSessionTarget redirects when base URL set, else buyer unavailable", () => {
  const redirect = resolveLiveSessionTarget({
    liveSessionBaseUrl: "https://novnc.example/vnc.html",
    novncPassword: "pw",
  }, "attention-9");
  assert.equal(redirect.mode, "redirect");
  assert.match(redirect.url, /^https:\/\/novnc\.example\/vnc\.html/);
  assert.equal(redirect.hasPassword, true);

  const unavailable = resolveLiveSessionTarget({}, "attention-9");
  assert.equal(unavailable.mode, "unavailable");
  assert.equal(unavailable.message, liveBrowserUnavailableMessage());
  assert.match(unavailable.message, /temporarily unavailable/i);
  assert.doesNotMatch(unavailable.message, /gcloud|IAP|SSH|tunnel/i);
  // Founder helper remains available for docs/ops — not buyer copy.
  assert.match(unavailable.iapHelperCommand, /start-iap-tunnel/);
  assert.match(unavailable.iapHelperCommand, /6080/);
  assert.match(unavailable.localUrl, /127\.0\.0\.1:6080/);
  assert.match(defaultIapHelperCommand(), /gcloud compute start-iap-tunnel/);
});

test("live-session proxy path keeps token out of email-facing VNC URL", () => {
  const path = buildLiveSessionProxyPath("attention-abc", "tok.en");
  assert.equal(path, "/api/attention/attention-abc/live-session?token=tok.en");
  const embed = buildLiveSessionProxyPath("attention-abc", "tok.en", { embed: true });
  assert.equal(embed, "/api/attention/attention-abc/live-session?token=tok.en&embed=1");
  const absolute = buildLiveSessionProxyUrl("https://jobappagent.com", "attention-abc", "tok.en", { embed: true });
  assert.equal(
    absolute,
    "https://jobappagent.com/api/attention/attention-abc/live-session?token=tok.en&embed=1",
  );
});

test("embed helpers expose frame-src origins and embed query detection", () => {
  const origins = liveSessionFrameSrcOrigins("https://novnc.example:8443/vnc.html");
  assert.ok(origins.includes("'self'"));
  assert.ok(origins.includes("https://novnc.example:8443"));
  assert.ok(origins.includes("http://127.0.0.1:6080"));

  assert.equal(wantsLiveSessionEmbed(new URL("https://jobappagent.com/api/attention/a/live-session?embed=1")), true);
  assert.equal(wantsLiveSessionEmbed(new URL("https://jobappagent.com/api/attention/a/live-session")), false);
});
