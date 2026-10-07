import assert from "node:assert/strict";
import test from "node:test";
import { isStorageHealthy } from "../lib/health.mjs";

async function render(path = "/", bindings = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ...bindings }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the focused cloud offer and honest community proof", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const html = await response.text();
  assert.match(html, /Set the goal/);
  assert.match(html, /Hosted \+ cloud sequence/);
  assert.match(html, /Founding reservation · \$49/);
  assert.match(html, /Founding reservation open/);
  assert.doesNotMatch(html, /October\s*1(?:5)?,?\s*2026|2026-10-(?:01|15)|datetime="2026-10/i);
  assert.doesNotMatch(html, /Time remaining until cloud launch|Scheduled start|T− ACTIVE|DATE REACHED/i);
  assert.match(html, /Total installations/);
  assert.doesNotMatch(html, /Active installations · last 30 days|last 30 days/i);
  assert.match(html, /Verified applications submitted/);
  assert.match(html, /Jobs assessed/);
  assert.match(html, /Reserve for \$49/);
  assert.match(html, /India\/regional founding price \+ GST may appear at checkout/);
  assert.match(html, /Verified facts only/);
  assert.match(html, /Secure checkout by Dodo Payments/);
  assert.match(html, /Reserve founding access/);
  assert.match(html, /lock founding reservation pricing/);
  assert.match(html, /email a confirmation/);
  assert.match(html, /What am I paying for\?/);
  assert.match(html, /founding-price reservation for hosted/);
  assert.doesNotMatch(html, /41\.73/);
  assert.doesNotMatch(html, /60 days|automatically refund|money-back|money back/i);
  assert.doesNotMatch(html, /HOSTED OPEN|Founding hosted open|unlock activatable|When do my 90 days|starts when we activate|still verifying|when cloud opens|when cloud access is ready|hold the founding price/i);
  assert.doesNotMatch(html, /Hosted continuity<\/span><strong>READY<\/strong>/);
  assert.match(html, /Hosted continuity<\/span><strong>COMING SOON<\/strong>/);
  assert.match(html, /Cloud access<\/span><strong>COMING SOON<\/strong>/);
  assert.doesNotMatch(html, /WINDOW OPEN|cloud launch window is now open/i);
  assert.doesNotMatch(html, /Cloud access<\/span><strong>OPEN<\/strong>/);
  assert.doesNotMatch(html, /Hosted continuity<\/span><strong>VERIFYING<\/strong>/);
  assert.doesNotMatch(html, /filled\s*[≠!=]+\s*applied/i);
  assert.doesNotMatch(html, /no fixed public launch date|no hard (?:launch )?date|there is no fixed/i);
  assert.doesNotMatch(html, /class="topbar"/);
  assert.doesNotMatch(html, /Run it locally|Install from GitHub|Join early access|first 50/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders human-readable privacy and terms pages", async () => {
  const [privacy, terms] = await Promise.all([render("/privacy"), render("/terms")]);
  assert.equal(privacy.status, 200); assert.equal(terms.status, 200);
  const privacyHtml = await privacy.text();
  const termsHtml = await terms.text();
  assert.match(privacyHtml, /Privacy, in plain language/);
  assert.match(termsHtml, /one-time \$49 payment for founding hosted access/);
  assert.match(termsHtml, /reserves founding pricing/);
  assert.doesNotMatch(termsHtml, /90-day access period|Hosted continuity is open|60 days|automatically request a full refund|Activation and refund promise|pre-launch reservation|money-back|money back/i);
  assert.doesNotMatch(privacyHtml, /60-day activation promise|support refunds/i);
});

test("platform guides render usable prompts and publish only known platform routes", async () => {
  const catalog = await (await render("/platforms")).text();
  const sitemap = await (await render("/sitemap.xml")).text();
  for (const platform of ["hermes", "grok", "openclaw"]) {
    assert.match(catalog, new RegExp(`href="/platforms/${platform}"`));
    assert.match(sitemap, new RegExp(`https://jobappagent.com/platforms/${platform}`));
    const response = await render(`/platforms/${platform}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /id="setup-prompt"/);
    assert.match(html, /review-each/);
    assert.match(html, /npx job-application-agent@latest install/);
    assert.match(html, /visible ATS success/);
  }
  const unknown = await render("/platforms/unknown-agent");
  assert.equal(unknown.status, 404);
});

test("server-renders a payment return page that waits for verified status", async () => {
  const response = await render("/checkout/return?purchase_id=11111111-1111-4111-8111-111111111111");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Checking your payment/);
  assert.match(html, /verified webhook/);
});

test("server-renders a design-only checkout success fixture without claiming paid status", async () => {
  const response = await render("/checkout/return?design=success");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Success preview|founding reservation is confirmed/i);
  assert.match(html, /email a reservation confirmation/i);
  assert.match(html, /no access window starts at payment/i);
  assert.match(html, /no instant self-serve dashboard/i);
  assert.match(html, /Design fixture only/i);
  assert.match(html, /Back home/);
  assert.doesNotMatch(html, /Payment verified/);
  assert.doesNotMatch(html, /Not confirmed|could not verify this payment/i);
});

test("attention missing-token UI includes a Back home recovery CTA", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/attention/[id]/page.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /Back home/);
  assert.match(source, /attention-error-actions/);
  assert.match(source, /needs a secure token/i);
});

test("attention design harness and judgment have no operational preview actions", async () => {
  const fs = await import("node:fs/promises");
  const page = await fs.readFile(new URL("../app/attention/[id]/page.tsx", import.meta.url), "utf8");
  const actions = await fs.readFile(new URL("../app/attention/[id]/AttentionActions.tsx", import.meta.url), "utf8");
  const answers = await fs.readFile(new URL("../app/attention/[id]/AttentionAnswerFields.tsx", import.meta.url), "utf8");
  assert.match(page, /resolveAttentionDesignFixture\(query, attentionId\)/);
  assert.ok(page.indexOf("if (fixture)") < page.indexOf("if (!token)"));
  assert.match(actions, /if \(designFixture\) return true/);
  assert.match(actions, /canContinueApplying/);
  assert.doesNotMatch(actions, /\/wake|\/live-session|Open live|Try again|I’ve finished/);
  assert.match(answers, /if \(designFixture\) return;/);
  assert.match(answers, /designFixture \|\| aiAssistanceDiscouraged/);
});

test("community and homepage CTAs use Reserve for $49", async () => {
  const [home, community] = await Promise.all([render("/"), render("/community-view")]);
  assert.equal(home.status, 200);
  assert.equal(community.status, 200);
  for (const html of [await home.text(), await community.text()]) {
    assert.match(html, /Reserve for \$49/);
    assert.match(html, /India\/regional founding price \+ GST may appear at checkout/);
    assert.doesNotMatch(html, /Activate founding access|Unlock activatable|Reserve 90-day access/i);
    assert.doesNotMatch(html, /41\.73/);
  }
});

test("server-renders the branded community dashboard", async () => {
  const response = await render("/community-view");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Aggregate product evidence/);
  assert.match(html, /See the work the agent is doing/);
  assert.match(html, /Current adoption and verified execution/);
  assert.match(html, /Total installations/);
  assert.match(html, /lifetime cumulative totals/i);
  assert.doesNotMatch(html, /Active installations · last 30 days|Active installation.*last 30 days/i);
  assert.match(html, /Activity over time, with outcomes kept in context/);
  assert.match(html, /Verified submissions by day/);
  assert.match(html, /Where the work is concentrated/);
  assert.match(html, /Role levels discovered/);
  assert.match(html, /How the evidence is counted/);
  assert.doesNotMatch(html, /Community job leads|Open job|maintainer-reviewed/i);
  assert.match(html, /Anonymous aggregate telemetry/);
  assert.doesNotMatch(html, /Install agent|Open source on GitHub/i);
});

test("publishes crawler guidance and a canonical sitemap", async () => {
  const [robots, sitemap] = await Promise.all([render("/robots.txt"), render("/sitemap.xml")]);
  assert.equal(robots.status, 200);
  assert.equal(sitemap.status, 200);
  assert.match(await robots.text(), /Disallow: \/api\//);
  const sitemapXml = await sitemap.text();
  assert.match(sitemapXml, /https:\/\/jobappagent\.com\/privacy/);
  assert.match(sitemapXml, /https:\/\/stats\.jobappagent\.com/);
});

test("provides an unlisted, non-indexable published jobs page", async () => {
  const response = await render("/jobs");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Published jobs/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.match(html, /Loading published jobs/);
  assert.match(html, /not placements or jobs secured/);
  for (const path of ["/", "/community-view", "/sitemap.xml"]) {
    const publicHtml = await (await render(path)).text();
    assert.doesNotMatch(publicHtml, /(?:href="[^"]*\/jobs(?:"|\?)|<loc>[^<]*\/jobs<)/);
  }
});

test("reports storage healthy only when the database probe responds", async () => {
  const healthyDb = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
  const unhealthyDb = { prepare: () => ({ first: async () => { throw new Error("unavailable"); } }) };
  assert.equal(await isStorageHealthy(healthyDb), true);
  assert.equal(await isStorageHealthy(unhealthyDb), false);
});
