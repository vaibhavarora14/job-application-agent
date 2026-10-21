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
  assert.match(html, /id="launch-countdown-title">Cloud access</);
  assert.match(html, /Founding reservation · \$49/);
  assert.match(html, /Founding reservation open/);
  assert.match(html, /FOUNDING RESERVATION/);
  assert.match(html, /Smarter agent on cloud\./);
  assert.match(html, /Cloud access is coming soon — a hosted agent that runs for you/);
  assert.match(html, /Cloud access remains coming soon; no launch date promised/);
  assert.match(html, /Cloud access is coming soon\. \$49 reserves founding pricing/);
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
  assert.match(html, /founding-price reservation for cloud access/);
  assert.doesNotMatch(html, /41\.73/);
  assert.doesNotMatch(html, /60 days|automatically refund|money-back|money back/i);
  assert.doesNotMatch(html, /HOSTED OPEN|Founding hosted open|unlock activatable|When do my 90 days|starts when we activate|still verifying|when cloud opens|when cloud access is ready|hold the founding price/i);
  assert.doesNotMatch(html, /Hosted \+ cloud sequence|Hosted continuity|Hosted and Cloud are both|Hosted access remains coming soon|founding-price reservation for hosted/i);
  assert.match(html, /Agent foundation<\/span><strong>RELEASED<\/strong>/);
  assert.match(html, /Cloud access<\/span><strong>COMING SOON<\/strong>/);
  assert.doesNotMatch(html, /WINDOW OPEN|cloud launch window is now open/i);
  assert.doesNotMatch(html, /Cloud access<\/span><strong>OPEN<\/strong>/);
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
  assert.match(termsHtml, /one-time \$49 payment for founding cloud access/);
  assert.match(termsHtml, /reserves founding pricing/);
  assert.doesNotMatch(termsHtml, /90-day access period|Hosted continuity is open|separate product surfaces|60 days|automatically request a full refund|Activation and refund promise|pre-launch reservation|money-back|money back/i);
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
    if (platform === "grok") {
      assert.match(html, /class="eyebrow"[^>]*>Grok Bot[\s\S]*?Bot template · review mode[\s\S]*?<h1/i);
      assert.match(html, /class="button"[^>]*href="https:\/\/x\.ai\/bot\/0PNQABev0aiAUlhWI83XH"/);
      assert.match(html, /Open the (?:<!-- -->)?Grok Bot(?:<!-- -->)? template/);
      assert.match(html, /Starts in review mode, where every submit is confirmed\./);
      assert.doesNotMatch(html, /template<\/a>\s*[—-]\s*[Ss]tarts in review mode/);
      assert.doesNotMatch(html, /native share link pending/i);
    }
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

test("attention invalid/expired copy avoids jargon and points to the latest email", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/attention/[id]/page.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /This link has expired/);
  assert.match(source, /still paused and waiting for your answer/);
  assert.match(source, /Nothing was submitted from this link/);
  assert.match(source, /Find the newest JobAppAgent email/);
  assert.match(source, /This page cannot open your inbox/);
  assert.match(source, /Open the inbox where you receive JobAppAgent mail/);
  assert.match(source, /button button-secondary[^>]*>Go to JobAppAgent home/);
  assert.match(source, /site-shell/);
  assert.match(source, /SiteHeader/);
  assert.match(source, /SiteFooter/);
  assert.doesNotMatch(source, /Open the latest email from JobAppAgent/);
  assert.doesNotMatch(source, /This attention link is not valid/);
});

test("branded 404 page uses plain recovery copy and site CTAs", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/not-found.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /We can’t find that page/);
  assert.match(source, /Your agent and applications aren’t affected/);
  assert.match(source, /Go to JobAppAgent home/);
  assert.match(source, /Browse published jobs/);
  assert.match(source, /href="\/jobs"/);
  assert.match(source, /SiteHeader/);
  assert.match(source, /SiteFooter/);
  assert.match(source, /site-shell/);
});

test("product SiteHeader nav works from non-home pages", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/components/SiteChrome.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /href=\{community \? "https:\/\/jobappagent\.com" : "\/#top"\}/);
  assert.match(source, /href="\/#process"/);
  assert.match(source, /href="\/#boundaries"/);
  assert.match(source, /<Link href="\/#process">How it works<\/Link>/);
  assert.match(source, /<Link href="\/#boundaries">Boundaries<\/Link>/);
  assert.match(source, /foundingCta = true/);
  assert.match(source, /foundingCta \? <FoundingCheckout compact \/> : null/);
});

test("jobs empty state offers Install JobAppAgent when unfiltered", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/jobs/JobsBoard.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /No open roles right now/);
  assert.match(source, /New listings appear here as maintainers review the community registry/);
  assert.match(source, /Install JobAppAgent/);
  assert.match(source, /jobappagent\.com\/platforms/);
  assert.match(source, /Clear filters/);
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
  // Decision 2026-10-21: the reported-interviews count is not shown publicly.
  assert.doesNotMatch(html, /interview/i);
});

test("homepage community proof does not show an interviews stat", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Total installations/);
  assert.match(html, /Verified applications submitted/);
  assert.match(html, /Jobs assessed/);
  assert.doesNotMatch(html, /interview/i);
});

test("publishes crawler guidance and a host-local apex sitemap", async () => {
  const [robots, sitemap, statsSitemap] = await Promise.all([
    render("/robots.txt"),
    render("/sitemap.xml"),
    render("/stats-sitemap.xml"),
  ]);
  assert.equal(robots.status, 200);
  assert.equal(sitemap.status, 200);
  assert.equal(statsSitemap.status, 200);
  assert.match(await robots.text(), /Disallow: \/api\//);
  const sitemapXml = await sitemap.text();
  assert.match(sitemapXml, /https:\/\/jobappagent\.com\/privacy/);
  assert.match(sitemapXml, /https:\/\/jobappagent\.com\/jobs</);
  assert.doesNotMatch(sitemapXml, /stats\.jobappagent\.com/);
  const statsXml = await statsSitemap.text();
  assert.match(statsXml, /https:\/\/stats\.jobappagent\.com\//);
  assert.doesNotMatch(statsXml, /jobappagent\.com\/platforms/);
});

test("homepage head includes apex canonical and schema.org JSON-LD without offers", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /rel="canonical" href="https:\/\/jobappagent\.com\/?"/);
  assert.match(html, /type="application\/ld\+json"/);
  assert.match(html, /"@type":"Organization"/);
  assert.match(html, /"@type":"WebSite"/);
  assert.match(html, /"@type":"SoftwareApplication"/);
  assert.doesNotMatch(html, /"@type":"SoftwareApplication"[^<]*"offers"/);
  assert.doesNotMatch(html, /"@type":"Offer"/);

  const ldBlocks = [...html.matchAll(/type="application\/ld\+json"[^>]*>([^<]+)</g)].map((match) => match[1]);
  assert.ok(ldBlocks.length >= 1);
  for (const raw of ldBlocks) {
    const parsed = JSON.parse(raw.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    const nodes = parsed["@graph"] ?? [parsed];
    for (const node of nodes) {
      assert.equal(typeof node["@type"], "string");
      assert.equal("offers" in node, false);
      assert.equal("price" in node, false);
    }
  }
});

test("platform pages publish BreadcrumbList JSON-LD and apex canonicals", async () => {
  for (const path of ["/platforms", "/platforms/grok"]) {
    const html = await (await render(path)).text();
    assert.match(html, new RegExp(`rel="canonical" href="https://jobappagent.com${path}"`));
    assert.match(html, /"@type":"BreadcrumbList"/);
    assert.match(html, /ListItem/);
  }
});

test("publishes an indexable jobs board with shared site chrome", async () => {
  const previous = process.env.USE_JOBS_BOARD_FIXTURES;
  process.env.USE_JOBS_BOARD_FIXTURES = "1";
  try {
    const response = await render("/jobs");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /Open roles, reviewed/);
    assert.match(html, /canonical" href="https:\/\/jobappagent\.com\/jobs"/);
    assert.match(html, /og:title" content="Open roles/);
    assert.match(html, /og:url" content="https:\/\/jobappagent\.com\/jobs"/);
    assert.match(html, /twitter:title" content="Open roles/);
    assert.doesNotMatch(html, /name="robots" content="noindex/);
    // Shared SiteHeader nav without founding CTA on /jobs* (+ phone Menu toggle).
    assert.match(html, /stats\.jobappagent\.com/);
    assert.match(html, /How it works/);
    assert.match(html, /Boundaries/);
    assert.match(html, /site-nav-jobs/);
    assert.match(html, /site-mobile-menu/);
    assert.match(html, /<summary>Menu<\/summary>/);
    // Whole page must stay free of founding pricing (header included).
    assert.doesNotMatch(html, /\$49|Reserve for \$49|Reserve founding|Founding reservation|FOUNDING RESERVATION/i);
    assert.doesNotMatch(html, /contributor_hash|contributorHash/);
    assert.match(html, /Reviewed and live, checked daily|Apply with your agent|Roles reviewed by maintainers/);
    assert.match(html, /Example Labs|Senior Backend Engineer/);
    // List-row apply CTAs are outline secondary; solid primary stays on detail.
    assert.match(html, /button button-secondary[^>]*>Apply with your agent/);

    const closed = await render("/jobs/example-mark-product-designer-eeeeeeeeeeeeeeee");
    assert.equal(closed.status, 200);
    const closedHtml = await closed.text();
    assert.match(closedHtml, /This role closed on/);
    assert.match(closedHtml, /application\/ld\+json/);
    assert.match(closedHtml, /validThrough/);
    assert.doesNotMatch(closedHtml, /npx job-application-agent@latest install/);
    assert.doesNotMatch(closedHtml, /\$49|Reserve for \$49|Founding reservation/i);

    const open = await render("/jobs/example-labs-senior-backend-engineer-aaaaaaaaaaaaaaaa");
    assert.equal(open.status, 200);
    const openHtml = await open.text();
    assert.match(openHtml, /Reviewed and live, checked daily/);
    assert.match(openHtml, /Last checked /);
    assert.doesNotMatch(openHtml, /Last checked [^<"']{0,40}Reviewed and live/);
    assert.match(openHtml, /npx job-application-agent@latest apply /);
    assert.match(openHtml, /Apply in review mode/);
    assert.match(openHtml, /og:url" content="https:\/\/jobappagent\.com\/jobs\//);
    assert.match(openHtml, /application\/ld\+json/);
    assert.match(openHtml, /validThrough/);
    assert.match(openHtml, /TELECOMMUTE|applicantLocationRequirements/);
    assert.doesNotMatch(openHtml, /\$49|Reserve for \$49|Reserve founding|Founding reservation|FOUNDING RESERVATION/i);
  } finally {
    if (previous === undefined) delete process.env.USE_JOBS_BOARD_FIXTURES;
    else process.env.USE_JOBS_BOARD_FIXTURES = previous;
  }
});

test("reports storage healthy only when the database probe responds", async () => {
  const healthyDb = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
  const unhealthyDb = { prepare: () => ({ first: async () => { throw new Error("unavailable"); } }) };
  assert.equal(await isStorageHealthy(healthyDb), true);
  assert.equal(await isStorageHealthy(unhealthyDb), false);
});
