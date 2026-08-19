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
  assert.match(html, /Active installations · last 30 days/);
  assert.match(html, /Verified applications submitted/);
  assert.match(html, /Jobs assessed/);
  assert.match(html, /Reserve 90-day access · \$49/);
  assert.match(html, /Verified facts only/);
  assert.match(html, /Secure checkout by Dodo Payments/);
  assert.doesNotMatch(html, /Run it locally|Install from GitHub|Join early access|first 50/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders human-readable privacy and terms pages", async () => {
  const [privacy, terms] = await Promise.all([render("/privacy"), render("/terms")]);
  assert.equal(privacy.status, 200); assert.equal(terms.status, 200);
  assert.match(await privacy.text(), /Privacy, in plain language/);
  assert.match(await terms.text(), /one-time \$49 purchase/);
});

test("server-renders a payment return page that waits for verified status", async () => {
  const response = await render("/checkout/return?purchase_id=11111111-1111-4111-8111-111111111111");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Checking your payment/);
  assert.match(html, /verified webhook/);
});

test("server-renders the branded community dashboard", async () => {
  const response = await render("/community-view");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Community momentum/);
  assert.match(html, /Reported activity by day/);
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

test("reports storage healthy only when the database probe responds", async () => {
  const healthyDb = { prepare: () => ({ first: async () => ({ ok: 1 }) }) };
  const unhealthyDb = { prepare: () => ({ first: async () => { throw new Error("unavailable"); } }) };
  assert.equal(await isStorageHealthy(healthyDb), true);
  assert.equal(await isStorageHealthy(unhealthyDb), false);
});
