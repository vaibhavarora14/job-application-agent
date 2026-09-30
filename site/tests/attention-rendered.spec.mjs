import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAttentionDesignFixture, ATTENTION_DESIGN_FIXTURE_KEYS } from "../lib/attention-design-fixtures.mjs";

// Render actual client components without the Worker runtime or any network calls.
const folder = await mkdtemp(new URL("../node_modules/.attention-render-", import.meta.url));
let BuyerFlow;
try {
  const outfile = path.join(folder, "buyer.mjs");
  await build({
    entryPoints: [new URL("../app/attention/[id]/BuyerFlow.tsx", import.meta.url).pathname],
    outfile, bundle: true, platform: "node", format: "esm", jsx: "automatic",
    external: ["react", "react-dom"], logLevel: "silent",
  });
  ({ BuyerFlow } = await import(pathToFileURL(outfile)));
} finally {
  await rm(folder, { recursive: true, force: true });
}

const forbidden = /CAPTCHA|Open live session|Open live browser|Try again|Resume application|Almost there|human-proof|session-lost|recovering|I've finished|I’ve finished/i;

for (const key of ATTENTION_DESIGN_FIXTURE_KEYS) {
  test(`renders locked ${key} fixture`, () => {
    const fixture = buildAttentionDesignFixture(key);
    const html = renderToStaticMarkup(createElement(BuyerFlow, { view: fixture.view, initialStep: fixture.step, designFixture: true }));
    assert.match(html, /Design fixture only/);
    if (key === "admin") {
      assert.match(html, /ADMIN ONLY · DESIGN-ONLY · NOT BUYER UI/);
      assert.match(html, /Open session/);
    } else {
      assert.doesNotMatch(html, forbidden);
      assert.doesNotMatch(html, /<iframe/);
    }
    if (fixture.step === "judgment") assert.match(html, /disabled=""[^>]*>Continue applying<\/button>/);
    if (key === "preflight") assert.match(html, /Start applying/);
    if (key === "choose") assert.match(html, /Apply to 3 jobs/);
    if (key === "done") assert.match(html, /Back to search/);
  });
}

test("real queue and judgment exclude all design and ops chrome", () => {
  const { view } = buildAttentionDesignFixture("judgment");
  for (const initialStep of ["queue", "judgment"]) {
    const html = renderToStaticMarkup(createElement(BuyerFlow, { view, initialStep }));
    assert.doesNotMatch(html, forbidden);
    assert.doesNotMatch(html, /Design fixture|ADMIN ONLY|Open session|data-design-fixture/);
    assert.doesNotMatch(html, /Applied|Application confirmed|Submitted on the employer site/);
  }
});
