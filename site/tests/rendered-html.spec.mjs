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
  assert.match(html, /Find the role\./);
  // deploy-site.yml verify strings stay on the page after the design-review rework.
  assert.match(html, /Cloud access opens later; no launch date is set/);
  assert.match(html, /Cloud · Coming soon/);
  assert.match(html, /Founding reservation · \$49/);
  assert.match(html, /Founding reservation open/);
  assert.match(html, /COMING SOON/);
  assert.match(html, /FOUNDING RESERVATION/);
  assert.match(html, /Smarter agent on cloud: it runs the search for you\./);
  assert.match(html, /Cloud access is coming soon\. \$49 reserves founding pricing/);
  // Design review: no status card, no duplicate price line, no unapproved founder note.
  assert.doesNotMatch(html, /launch-countdown-title|<small>Founding reservation · \$49<\/small>/);
  assert.doesNotMatch(html, /Why I’m taking money before Cloud exists|maker of JobAppAgent/);
  assert.doesNotMatch(html, /October\s*1(?:5)?,?\s*2026|2026-10-(?:01|15)|datetime="2026-10/i);
  assert.doesNotMatch(html, /Time remaining until cloud launch|Scheduled start|T− ACTIVE|DATE REACHED/i);
  // Lifetime counters render client-side only once real (no placeholder SSR).
  assert.doesNotMatch(html, /Active installations · last 30 days|last 30 days/i);
  assert.doesNotMatch(html, /resting|metric-empty/i);
  assert.match(html, /Reserve for \$49/);
  assert.match(html, /India\/regional founding price \+ GST may appear at checkout/);
  assert.match(html, /Verified facts only/);
  assert.match(html, /Secure checkout by Dodo Payments/);
  assert.match(html, /Reserve founding access/);
  assert.match(html, /lock the founding price/);
  assert.match(html, /email a confirmation/);
  assert.match(html, /What am I paying for\?/);
  assert.match(html, /founding-price reservation for cloud access/);
  // Pre-purchase limits: buyers see the CAPTCHA/question pauses before paying.
  assert.match(html, /You stay in the loop\. Some applications pause for a CAPTCHA or an employer question, and the agent waits for a quick step from you before it carries on\./);
  assert.match(html, /We email a confirmation\./);
  assert.match(html, /There is no instant self-serve dashboard yet\./);
  assert.match(html, /<summary>Is it fully hands-off\?<\/summary>/);
  assert.match(html, /Not completely\. Some applications stop at a CAPTCHA or a question only you can answer\. The agent pauses there until you take a quick step, then keeps going\./);
  assert.doesNotMatch(html, /asks you to take a quick step/);
  assert.doesNotMatch(html, /41\.73/);
  assert.doesNotMatch(html, /60 days|automatically refund|money-back|money back/i);
  assert.doesNotMatch(html, /HOSTED OPEN|Founding hosted open|unlock activatable|When do my 90 days|starts when we activate|still verifying|when cloud opens|when cloud access is ready|hold the founding price/i);
  assert.doesNotMatch(html, /Hosted \+ cloud sequence|Hosted continuity|Hosted and Cloud are both|Hosted access remains coming soon|founding-price reservation for hosted/i);
  // Status card removed (design review); the progress checklist carries released vs coming soon.
  assert.match(html, /Open-source agent released on npm and GitHub/);
  assert.match(html, /class="launch-state"><i aria-hidden="true"><\/i>COMING SOON</);
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
  assert.match(html, /Your access window does not start at payment/i);
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
  assert.match(source, /Browse open roles/);
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
  // Revamp (theme B): nav follows the three pillars; anchors resolve from any page.
  assert.match(source, /<Link href="\/jobs">Job board<\/Link>/);
  assert.match(source, /<Link href="\/open-source">Open source<\/Link>/);
  assert.match(source, /<Link href="\/#cloud">Cloud<\/Link>/);
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
  const homeHtml = await home.text();
  // Design review: the regional note sits only under the offer-panel button, not the header CTA.
  assert.match(homeHtml, /India\/regional founding price \+ GST may appear at checkout/);
  for (const html of [homeHtml, await community.text()]) {
    assert.match(html, /Reserve for \$49/);
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
  // Need-only (design review v2): with no stats in SSR, data sections and cards are absent.
  assert.doesNotMatch(html, /Evidence at a glance|Current adoption and verified execution|lifetime cumulative totals/i);
  assert.doesNotMatch(html, /Live feed resting|is resting|of — verified/);
  assert.doesNotMatch(html, /Active installations · last 30 days|Active installation.*last 30 days/i);
  assert.doesNotMatch(html, /Activity over time, with outcomes kept in context|Verified submissions by day|Outcome coverage/);
  assert.doesNotMatch(html, /Where the work is concentrated|Role levels discovered|Waiting for enough privacy-safe data/);
  assert.ok((html.match(/Waiting for verified activity\./g) ?? []).length <= 1);
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
  assert.doesNotMatch(html, /interview/i);
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../app/components/CommunityProof.tsx", import.meta.url), "utf8"),
  );
  assert.match(source, /Total installations/);
  assert.match(source, /Verified applications submitted/);
  assert.match(source, /Jobs assessed/);
  assert.match(source, /if \(!hasLifetimeCounters\(data\)\) return null;/);
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
  const robotsTxt = await robots.text();
  assert.match(robotsTxt, /Disallow: \/api\//);
  assert.match(robotsTxt, /Crawl-delay: 10/);
  const sitemapXml = await sitemap.text();
  assert.match(sitemapXml, /https:\/\/jobappagent\.com\/privacy/);
  assert.match(sitemapXml, /https:\/\/jobappagent\.com\/jobs</);
  assert.match(sitemapXml, /https:\/\/jobappagent\.com\/open-source</);
  assert.match(sitemapXml, /https:\/\/jobappagent\.com\/compare</);
  assert.doesNotMatch(sitemapXml, /stats\.jobappagent\.com/);
  const statsXml = await statsSitemap.text();
  assert.match(statsXml, /https:\/\/stats\.jobappagent\.com\//);
  assert.doesNotMatch(statsXml, /jobappagent\.com\/platforms/);
});

test("open-source and compare pages pair JobAppAgent with open-source job application agent, without pricing", async () => {
  const [openSource, compare] = await Promise.all([render("/open-source"), render("/compare")]);
  assert.equal(openSource.status, 200);
  assert.equal(compare.status, 200);
  const openHtml = await openSource.text();
  const compareHtml = await compare.text();
  assert.match(openHtml, /<title>JobAppAgent: the open-source job application agent<\/title>/);
  assert.match(openHtml, /<h1>JobAppAgent, the <span class="[^"]+">open\u2011source<\/span> job application agent<\/h1>/);
  assert.match(openHtml, /the GitHub repo <code>vaibhavarora14\/job-application-agent<\/code> and the npm package <code>job-application-agent<\/code> are the same project/);
  assert.doesNotMatch(openHtml, /Applications submitted|metric-empty/);
  assert.match(openHtml, />Copy</);
  assert.match(openHtml, />View on GitHub</);
  assert.match(openHtml, /href="\/compare"[^>]*>See how it compares</);
  assert.match(openHtml, /rel="canonical" href="https:\/\/jobappagent\.com\/open-source"/);
  assert.match(openHtml, /"@type":"SoftwareApplication","name":"JobAppAgent","alternateName":"job-application-agent"/);
  assert.match(openHtml, /"codeRepository":"https:\/\/github\.com\/vaibhavarora14\/job-application-agent"/);
  assert.match(compareHtml, /<title>Open-source job application agents compared \| JobAppAgent<\/title>/);
  assert.match(compareHtml, /<h1>How JobAppAgent compares to other <span class="[^"]+">open\u2011source<\/span> job agents<\/h1>/);
  assert.match(compareHtml, /href="\/open-source"[^>]*>About the project</);
  // Mobile cards: same eight projects as the table, with an approval tag each.
  assert.equal((compareHtml.match(/<span class="[^"]+">Approval before submit: /g) ?? []).length, 5);
  // Tools that never make the submit get a neutral "Never submits" tag, never the green yes.
  // Mobile tags and desktop approval cells agree for tools that never make the submit.
  assert.equal((compareHtml.match(/<span class="[^"]+">Never submits: you click Submit</g) ?? []).length, 2);
  assert.equal((compareHtml.match(/<span class="[^"]+">Never submits: you apply yourself</g) ?? []).length, 1);
  assert.equal((compareHtml.match(/<td>Never submits: you click Submit\. /g) ?? []).length, 2);
  assert.equal((compareHtml.match(/<td>Never submits: you apply yourself\. /g) ?? []).length, 1);
  assert.match(compareHtml, /Approval before submit: (?:<!-- -->)?yes</);
  assert.doesNotMatch(openHtml, /The code is on GitHub as/);
  assert.match(compareHtml, /Approval before submit: (?:<!-- -->)?no, by default/);
  assert.match(compareHtml, /Approval before submit: (?:<!-- -->)?not stated/);
  assert.match(compareHtml, /rel="canonical" href="https:\/\/jobappagent\.com\/compare"/);
  for (const html of [openHtml, compareHtml]) {
    assert.doesNotMatch(html, /\$49|Reserve for|Founding reservation|COMING SOON|\bbeta\b|"offers"|"price"/i);
    assert.doesNotMatch(html, /interview/i);
  }
});

test("product footer links the open-source and compare pages; platforms and privacy cross-link them", async () => {
  const [home, platforms, privacy] = await Promise.all([render("/"), render("/platforms"), render("/privacy")]);
  const homeHtml = await home.text();
  const footer = homeHtml.slice(homeHtml.lastIndexOf("<footer"));
  assert.match(footer, /href="\/open-source"[^>]*>Open source</);
  assert.match(footer, /href="\/compare"[^>]*>Compare</);
  const navHtml = homeHtml.slice(homeHtml.indexOf('aria-label="Primary navigation"'), homeHtml.indexOf("</nav>"));
  // Design review v2 (P2-F): nav "Open source" goes to /open-source; /compare stays footer-only.
  assert.match(navHtml, /href="\/open-source"[^>]*>Open source</);
  assert.doesNotMatch(navHtml, /\/compare/);
  for (const html of [await platforms.text(), await privacy.text()]) {
    assert.match(html, /href="\/open-source"[^>]*>About the project</);
    assert.match(html, /href="\/compare"[^>]*>See how it compares</);
  }
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
    assert.match(html, />Job board</);
    assert.match(html, />Open source</);
    assert.match(html, />Cloud</);
    assert.match(html, /site-nav-jobs/);
    assert.match(html, /site-mobile-menu/);
    assert.match(html, /<summary>Menu<\/summary>/);
    // Whole page must stay free of founding pricing (header included).
    assert.doesNotMatch(html, /\$49|Reserve for \$49|Reserve founding|Founding reservation|FOUNDING RESERVATION/i);
    assert.doesNotMatch(html, /contributor_hash|contributorHash/);
    assert.match(html, /Roles reviewed by maintainers/);
    assert.match(html, /Example Labs|Senior Backend Engineer/);
    // Redesign B: each role is one link; no per-row buttons; filters (sheet + sidebar) and count.
    assert.doesNotMatch(html, /Apply with your agent<\/a>/);
    assert.match(html, /<a[^>]+href="\/jobs\/example-labs-senior-backend-engineer-aaaaaaaaaaaaaaaa"/);
    assert.match(html, /5 open roles/);
    assert.match(html, /Newest posted first/);
    assert.match(html, /aria-haspopup="dialog"[^>]*>.*?Filters/);
    assert.match(html, /<legend>Workplace<\/legend>/);
    assert.match(html, /<legend>Minimum pay, per year<\/legend>/);
    assert.match(html, /Include roles without listed pay/);
    assert.match(html, /Compared in USD</);
    assert.doesNotMatch(html, /monthly exchange rates|Only roles where the employer states a level/);
    assert.doesNotMatch(html, /<legend>[^<]*(ATS|Source|Channel)/i);
    // Honest pay: employer range with currency in the pay chip; nothing when pay is unknown.
    // The range sits in its own no-wrap span so it never splits; the suffix may wrap under it.
    assert.match(html, /class="_?chip[^"]*_?chipPay[^"]*"><span class="[^"]*payRange[^"]*">\$150K–\$235K<\/span> USD</);
    assert.doesNotMatch(html, /Pay not listed|Not listed/);
    // At most 2 chips per role row.
    for (const row of html.match(/<a[^>]+href="\/jobs\/[^"]+"[^>]*>[\s\S]*?<\/a>/g) ?? []) {
      assert.ok((row.match(/class="_?chip[\s_"]/g) ?? []).length <= 2, row);
    }
    assert.match(html, /Showing 5 of 5/);
    assert.doesNotMatch(html, /Show \d+ more/);

    const remote = await (await render("/jobs?workplace=remote")).text();
    assert.match(remote, /3 roles match/);
    assert.match(remote, /aria-label="Remove filter Remote"/);
    assert.doesNotMatch(remote, /Platform Engineer, Payments/);

    const payOnly = await (await render("/jobs?nopay=0")).text();
    assert.match(payOnly, /2 roles match/);
    assert.doesNotMatch(payOnly, /Senior Backend Engineer/);

    const zero = await (await render("/jobs?workplace=onsite")).text();
    assert.match(zero, /0 roles match/);
    assert.match(zero, /No roles match these filters/);
    assert.match(zero, /“On-site” rules out every match\. Without it, 5 roles match\./);
    assert.match(zero, /Remove “On-site”/);

    const failed = await (await render("/jobs?design=error")).text();
    assert.match(failed, /We couldn(?:&#x27;|')t load the role list/);
    assert.match(failed, /Try again/);
    assert.match(failed, /Roles did not load/);

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
    // Apply bar: Copy prompt (primary) + Open posting on <ATS> (secondary), prompt preview, full CLI.
    assert.match(openHtml, /Copy prompt/);
    assert.match(openHtml, /Open posting on Greenhouse/);
    assert.match(openHtml, /Preview the prompt/);
    assert.match(openHtml, /Apply to this role with JobAppAgent in review mode/);
    assert.match(openHtml, /URL: https:\/\/boards\.greenhouse\.io\/exampleco\/jobs\/1001/);
    assert.match(openHtml, /npx job-application-agent@latest apply https:\/\/boards\.greenhouse\.io\/exampleco\/jobs\/1001/);
    // Design P1: no helper line in the bar; one-line card lead; CLI folded into a quiet disclosure.
    assert.doesNotMatch(openHtml, /For Cursor, Claude Code or Codex/);
    assert.match(openHtml, /Your agent fills the application and waits for your OK\./);
    assert.match(openHtml, /<summary>Preview the prompt/);
    assert.match(openHtml, /<summary>Prefer the terminal\?/);
    assert.doesNotMatch(openHtml, /<details[^>]* open/);
    assert.match(openHtml, /Read the full posting on Greenhouse/);
    assert.doesNotMatch(openHtml, />Apply<\/(a|button)>/);
    assert.doesNotMatch(openHtml, /posting\. Checked /);
    assert.match(openHtml, /og:url" content="https:\/\/jobappagent\.com\/jobs\//);
    assert.match(openHtml, /application\/ld\+json/);
    assert.match(openHtml, /validThrough/);
    assert.match(openHtml, /TELECOMMUTE|applicantLocationRequirements/);
    // Unknown pay: no Pay row and no placeholder text; other unknown facts are omitted too.
    assert.doesNotMatch(openHtml, /<dt>Pay<\/dt>/);
    assert.doesNotMatch(openHtml, /Pay not listed|Not listed/);
    assert.match(openHtml, /<dt>Workplace<\/dt><dd>Remote<\/dd>/);
    assert.match(openHtml, /<dt>Type<\/dt><dd>Full-time<\/dd>/);

    // Design-approved pay bands: muted "Name:" then the bold range as its own unsplittable span.
    const threeBands = await (await render("/jobs/example-pay-platform-engineer-payments-bbbbbbbbbbbbbbbb")).text();
    assert.match(threeBands, /class="_?payBandName[^"]*">Engineer II:<\/span> <span class="_?payBandRange[^"]*">\$150K–\$180K USD<\/span>/);
    assert.match(threeBands, /class="_?payBandRange[^"]*">\$150K–\$250K USD OTE<\/span>/);
    assert.match(threeBands, /<dt>Pay<\/dt>/);
    assert.doesNotMatch(threeBands, /more bands?</);
    const sixBands = await (await render("/jobs/example-health-product-designer-mobile-dddddddddddddddd")).text();
    assert.equal((sixBands.match(/class="_?payBandRange/g) ?? []).length, 4);
    assert.match(sixBands, /<a class="_?payBandMore[^"]*" href="https:\/\/apply\.workable\.com\/examplehealth\/j\/ABCDEF1234"[^>]*>\+2 more bands<\/a>/);
    assert.doesNotMatch(sixBands, /total comp|£85K/);
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

test("homepage revamp: free path first, Cloud reservation next, no dates or waitlist", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const id of ["free", "agent", "jobs", "process", "boundaries", "cloud", "founding"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.ok(html.indexOf('id="agent"') < html.indexOf('id="cloud"'));
  assert.match(html, /href="\/jobs"/);
  assert.match(html, /npx job-application-agent@latest install/);
  assert.match(html, /Available now/);
  assert.doesNotMatch(html, /Coming with Cloud|Launch readiness|designed, not live|One clear loop/);
  assert.match(html, /Try the free agent first/);
  assert.match(html, /When does Cloud launch\?/);
  assert.match(html, /<summary>Menu<\/summary>/);
  assert.match(html, /Reserve for \$49/);
  assert.match(html, /COMING SOON/);
  assert.doesNotMatch(html, /type="email"|waitlist|countdown timer|lifetime access|spots left/i);
  assert.doesNotMatch(html, /interview/i);
});
