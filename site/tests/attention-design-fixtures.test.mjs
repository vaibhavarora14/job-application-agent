import assert from "node:assert/strict";
import test from "node:test";
import { ATTENTION_DESIGN_FIXTURE_KEYS, ATTENTION_DESIGN_STEPS, buildAttentionDesignFixture, parseAttentionDesignKey, resolveAttentionDesignFixture } from "../lib/attention-design-fixtures.mjs";

test("six locked steps resolve with synthetic data and no credentials", () => {
  assert.deepEqual(ATTENTION_DESIGN_STEPS, ["preflight", "choose", "queue", "judgment", "done", "admin"]);
  for (const key of ATTENTION_DESIGN_FIXTURE_KEYS) {
    const fixture = resolveAttentionDesignFixture({ design: key }, "design");
    assert.ok(fixture, key);
    assert.equal(fixture.key, key);
    assert.equal(fixture.view.attentionId, "design");
    assert.equal(fixture.view.token, "");
    assert.equal(fixture.view.liveSessionUrl, undefined);
  }
  assert.match(buildAttentionDesignFixture("judgment").view.questions[0].prompt, /Why do you want to join Acme Robotics/);
});

test("legacy troubleshooting fixtures now show calm queue", () => {
  assert.equal(buildAttentionDesignFixture("questions").step, "judgment");
  for (const key of ["live-required", "unavailable", "retry", "resume-requested"]) {
    assert.equal(buildAttentionDesignFixture(key).step, "queue");
  }
});

test("unknown keys and non-design IDs cannot bypass authentication", () => {
  for (const design of [undefined, "", "bogus", "success", "__proto__", "constructor"]) {
    assert.equal(resolveAttentionDesignFixture({ design }, "design"), null);
  }
  for (const key of ATTENTION_DESIGN_FIXTURE_KEYS) {
    assert.equal(resolveAttentionDesignFixture({ design: key }, "attention-private"), null);
  }
  assert.equal(parseAttentionDesignKey({ design: " JUDGMENT " }), "judgment");
  assert.equal(parseAttentionDesignKey({ design: ["queue"] }), "queue");
  assert.equal(parseAttentionDesignKey(null), null);
  assert.equal(buildAttentionDesignFixture("nope"), null);
});
