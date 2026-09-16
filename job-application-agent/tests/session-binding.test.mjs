import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FILL_DISPLAY,
  FILL_VNC_PORT,
  FORBIDDEN_VNC_PORT,
  assertSameTab,
  createSessionBinding,
  extractSessionBindingFields,
  readSessionBindingFile,
  sessionBindingPath,
  validateSessionBinding,
  writeSessionBindingFile,
} from "../scripts/session-binding.mjs";

test("validateSessionBinding requires fill display and VNC 5900", () => {
  const ok = validateSessionBinding({
    attentionId: "attention-1",
    jobUrl: "https://jobs.ashbyhq.com/acme/application",
    browserProfilePath: "/tmp/jaa-chrome",
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.binding.display, FILL_DISPLAY);
  assert.equal(ok.binding.vncPort, FILL_VNC_PORT);

  const badPort = validateSessionBinding({
    attentionId: "attention-1",
    jobUrl: "https://jobs.example.com/a",
    browserProfilePath: "/tmp/p",
    vncPort: FORBIDDEN_VNC_PORT,
  });
  assert.equal(badPort.ok, false);
  assert.match(badPort.error, /5901/);

  const badDisplay = validateSessionBinding({
    attentionId: "attention-1",
    jobUrl: "https://jobs.example.com/a",
    browserProfilePath: "/tmp/p",
    display: ":1",
  });
  assert.equal(badDisplay.ok, false);
  assert.match(badDisplay.error, /forbidden|display/i);
});

test("assertSameTab detects drift and accepts same application path", () => {
  const same = assertSameTab(
    "https://jobs.ashbyhq.com/acme/job/123",
    "https://jobs.ashbyhq.com/acme/job/123?utm_source=x",
  );
  assert.equal(same.ok, true);

  const drift = assertSameTab(
    "https://jobs.ashbyhq.com/acme/job/123",
    "https://jobs.ashbyhq.com/acme",
  );
  assert.equal(drift.ok, false);
  assert.equal(drift.reason, "tab_drift");

  const hintFail = assertSameTab(
    "https://jobs.ashbyhq.com/acme/job/123",
    "https://jobs.ashbyhq.com/acme/job/123",
    { urlContains: "/application" },
  );
  assert.equal(hintFail.ok, false);
});

test("write/read session binding stays local under state dir", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jaa-binding-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const binding = createSessionBinding({
    attentionId: "attention-abc",
    jobUrl: "https://jobs.ashbyhq.com/acme/application",
    browserProfilePath: "/home/runner/.jaa-chrome-fill",
    applicationId: "app-1",
    roundId: "round-1",
    tabHint: { urlContains: "/application" },
  });
  const path = sessionBindingPath(dir, binding.attentionId);
  await writeSessionBindingFile(path, binding);
  const loaded = await readSessionBindingFile(path);
  assert.equal(loaded.attentionId, "attention-abc");
  assert.equal(loaded.vncPort, 5900);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.browserProfilePath, "/home/runner/.jaa-chrome-fill");
});

test("extractSessionBindingFields pulls local-only keys", () => {
  const fields = extractSessionBindingFields({
    url: "https://example.com",
    browserProfilePath: "/tmp/p",
    display: ":99",
    vncPort: 5900,
  });
  assert.equal(fields.browserProfilePath, "/tmp/p");
  assert.equal(fields.display, ":99");
  assert.equal(extractSessionBindingFields({ url: "https://example.com" }), null);
});
