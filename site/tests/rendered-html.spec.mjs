import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isStorageHealthy } from "../lib/health.mjs";

function pngDimensions(path) {
  const image = readFileSync(new URL(path, import.meta.url));
  assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) };
}

async function render(path = "/", bindings = {}, cfCountry) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const request = new Request(`http://localhost${path}`, { headers: { accept: "text/html" } });
  if (cfCountry) Object.defineProperty(request, "cf", { value: { country: cfCountry } });
  return worker.fetch(request, { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ...bindings }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the focused cloud offer and honest community proof", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  const html = await response.text();
  assert.match(html, /Set the boundaries/);
  assert.match(html, /JobAppAgent/);
  assert.match(html, /A calmer way to job hunt/);
  assert.match(html, /href="\/favicon\.png"/);
  assert.match(html, /href="\/apple-touch-icon\.png"/);
  assert.match(html, /href="\/manifest\.webmanifest"/);
  assert.doesNotMatch(html, />JA</);
  assert.match(html, /Systems that have used JobAppAgent · overall/);
  assert.match(html, /Verified applications submitted/);
  assert.match(html, /Jobs assessed/);
  assert.match(html, /Reserve at pre-launch price/);
  assert.match(html, /launches September 18, 2026/);
  assert.match(html, /\$49/);
  assert.match(html, /global pre-launch price/);
  assert.doesNotMatch(html, /₹3,999/);
  assert.match(html, /Verified facts only/);
  assert.match(html, /Secure checkout by Dodo Payments/);
  assert.match(html, /30 days from activation/);
  assert.doesNotMatch(html, /90 days from activation|90-day access/i);
  assert.doesNotMatch(html, /FOUNDING CLOUD ACCESS/);
  assert.doesNotMatch(html, /Run it locally|Install from GitHub|Join early access|first 50/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders only the India price for a visitor resolved to India", async () => {
  const response = await render("/", {}, "IN");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /₹3,999/);
  assert.match(html, /including GST in India/);
  assert.doesNotMatch(html, /\$49/);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("uses Cloudflare's country header when Sites dispatch omits request.cf", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const request = new Request("http://localhost/", {
    headers: { accept: "text/html", "cf-ipcountry": "IN" },
  });
  const response = await worker.fetch(request, { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  const html = await response.text();
  assert.match(html, /₹3,999/);
  assert.doesNotMatch(html, /\$49/);
});

test("does not trust a visitor-supplied country header", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const request = new Request("http://localhost/", {
    headers: { accept: "text/html", "x-jobappagent-country": "IN" },
  });
  const response = await worker.fetch(request, { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
  const html = await response.text();
  assert.match(html, /\$49/);
  assert.doesNotMatch(html, /₹3,999/);
});

test("publishes the approved Quiet Trust identity at every product-icon size", () => {
  assert.deepEqual(pngDimensions("../public/brand-mark.png"), { width: 256, height: 256 });
  assert.deepEqual(pngDimensions("../public/favicon.png"), { width: 64, height: 64 });
  assert.deepEqual(pngDimensions("../public/apple-touch-icon.png"), { width: 180, height: 180 });
  assert.deepEqual(pngDimensions("../public/icon-192.png"), { width: 192, height: 192 });
  assert.deepEqual(pngDimensions("../public/icon-512.png"), { width: 512, height: 512 });
  assert.deepEqual(pngDimensions("../public/og.png"), { width: 1200, height: 630 });

  const designSystem = readFileSync(new URL("../DESIGN.md", import.meta.url), "utf8");
  assert.match(designSystem, /boundary-run mark.*three shapes/i);
});

test("server-renders human-readable privacy and terms pages", async () => {
  const [privacy, terms] = await Promise.all([render("/privacy"), render("/terms")]);
  assert.equal(privacy.status, 200); assert.equal(terms.status, 200);
  assert.match(await privacy.text(), /Privacy, in plain language/);
  const termsHtml = await terms.text();
  assert.match(termsHtml, /one-time \$49 globally/);
  assert.match(termsHtml, /₹3,999 including GST for purchases localized to India/);
  assert.match(termsHtml, /30 days of cloud access from activation/);
  assert.match(termsHtml, /Purchases completed before this update retain the 90-day access term offered at checkout/);
});

test("server-renders a payment return page that waits for verified status", async () => {
  const response = await render("/checkout/return?purchase_id=11111111-1111-4111-8111-111111111111");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Checking your payment/);
  assert.match(html, /verified webhook/);
  const statusComponent = readFileSync(new URL("../app/components/PaymentReturnStatus.tsx", import.meta.url), "utf8");
  assert.match(statusComponent, /30 days begin when access is activated/);
  assert.doesNotMatch(statusComponent, /90 days begin when access is activated/);
});

test("server-renders the branded community dashboard", async () => {
  const response = await render("/community-view");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Community activity/);
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
