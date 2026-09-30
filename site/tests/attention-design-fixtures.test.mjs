import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENTION_DESIGN_FIXTURE_KEYS,
  attentionDesignFixtureCopy,
  attentionResumeRequestedNote,
  buildAttentionDesignFixture,
  parseAttentionDesignKey,
  resolveAttentionDesignFixture,
} from "../lib/attention-design-fixtures.mjs";
import {
  liveBrowserLoadFailedMessage,
  liveBrowserUnavailableMessage,
} from "../lib/attention-live-session.mjs";
import { needsLiveBrowser, hasJudgmentActions } from "../lib/attention-questions.mjs";

test("parseAttentionDesignKey accepts only known fixture keys", () => {
  assert.equal(parseAttentionDesignKey({ design: "questions" }), "questions");
  assert.equal(parseAttentionDesignKey({ design: "LIVE-REQUIRED" }), "live-required");
  assert.equal(parseAttentionDesignKey({ design: ["retry"] }), "retry");
  assert.equal(parseAttentionDesignKey({ design: "bogus" }), null);
  assert.equal(parseAttentionDesignKey({}), null);
  assert.equal(parseAttentionDesignKey({ design: "success" }), null);
  assert.equal(parseAttentionDesignKey(null), null);
});

test("resolveAttentionDesignFixture returns frozen views for all five keys", () => {
  assert.deepEqual([...ATTENTION_DESIGN_FIXTURE_KEYS], [
    "questions",
    "live-required",
    "unavailable",
    "retry",
    "resume-requested",
  ]);

  for (const key of ATTENTION_DESIGN_FIXTURE_KEYS) {
    const fixture = resolveAttentionDesignFixture({ design: key });
    assert.ok(fixture, `expected fixture for ${key}`);
    assert.equal(fixture.key, key);
    assert.equal(fixture.view.attentionId, "design");
    assert.equal(fixture.view.token, "design-fixture");
    assert.match(fixture.view.role, /Forward Deployed Engineer/);
    assert.equal(fixture.view.liveSessionEmbedUrl, "about:blank");
  }

  assert.equal(resolveAttentionDesignFixture({ design: "nope" }), null);
  assert.equal(resolveAttentionDesignFixture({}), null);
});

test("questions fixture: judgment Q&A, live optional", () => {
  const fixture = buildAttentionDesignFixture("questions");
  assert.ok(fixture);
  assert.equal(hasJudgmentActions(fixture.view.requiredActions), true);
  assert.equal(needsLiveBrowser(fixture.view.requiredActions), false);
  assert.ok(fixture.view.questions.length >= 1);
  assert.match(fixture.view.questions[0].prompt, /Why this role/i);
  assert.equal(fixture.ui.panelOpen, false);
  assert.equal(fixture.ui.status, null);
});

test("live-required fixture: Open live browser primary path", () => {
  const fixture = buildAttentionDesignFixture("live-required");
  assert.ok(fixture);
  assert.equal(needsLiveBrowser(fixture.view.requiredActions), true);
  assert.equal(fixture.view.liveSessionAvailable, true);
  assert.equal(fixture.ui.panelOpen, false);
  assert.equal(fixture.view.questions.length, 0);
});

test("unavailable fixture: panel open with soft unavailable copy", () => {
  const fixture = buildAttentionDesignFixture("unavailable");
  assert.ok(fixture);
  assert.equal(fixture.view.liveSessionAvailable, false);
  assert.equal(fixture.ui.panelOpen, true);
  assert.equal(attentionDesignFixtureCopy("unavailable"), liveBrowserUnavailableMessage());
  assert.match(liveBrowserUnavailableMessage(), /temporarily unavailable/i);
});

test("retry fixture: load-fail overlay seeded", () => {
  const fixture = buildAttentionDesignFixture("retry");
  assert.ok(fixture);
  assert.equal(fixture.view.liveSessionAvailable, true);
  assert.equal(fixture.ui.panelOpen, true);
  assert.equal(fixture.ui.loadFailed, true);
  assert.equal(fixture.ui.iframeSrc, "about:blank");
  assert.equal(attentionDesignFixtureCopy("retry"), liveBrowserLoadFailedMessage());
  assert.match(liveBrowserLoadFailedMessage(), /failed to load/i);
  assert.match(liveBrowserLoadFailedMessage(), /retry when ready/i);
});

test("resume-requested fixture: settled status note without signal POST", () => {
  const fixture = buildAttentionDesignFixture("resume-requested");
  assert.ok(fixture);
  assert.equal(fixture.ui.status, attentionResumeRequestedNote());
  assert.match(fixture.ui.status, /Resume requested/i);
  assert.match(fixture.ui.status, /not an application until you see confirmation/i);
  assert.equal(fixture.ui.panelOpen, false);
});

test("invalid design key builder returns null", () => {
  assert.equal(buildAttentionDesignFixture("not-a-key"), null);
});
