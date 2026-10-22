import assert from "node:assert/strict";
import test from "node:test";
import {
  breadcrumbListJsonLd,
  openSourceSoftwareJsonLd,
  siteJsonLdGraph,
  softwareApplicationJsonLd,
  statsRobotsTxt,
  statsSitemapXml,
} from "../lib/structured-data.mjs";

test("site JSON-LD graph includes Organization, WebSite, and SoftwareApplication without offers", () => {
  const graph = siteJsonLdGraph();
  assert.equal(graph["@context"], "https://schema.org");
  const types = graph["@graph"].map((node) => node["@type"]);
  assert.deepEqual(types, ["Organization", "WebSite", "SoftwareApplication"]);

  const serialized = JSON.stringify(graph);
  assert.doesNotMatch(serialized, /"offers"/);
  assert.doesNotMatch(serialized, /\$49|49\.00|"price"/);
  assert.match(serialized, /jobappagent\.com/);
  assert.match(serialized, /github\.com\/vaibhavarora14\/job-application-agent/);

  // schema.org-shaped: required identity fields present
  for (const node of graph["@graph"]) {
    assert.equal(typeof node["@type"], "string");
    assert.equal(typeof node.name, "string");
    assert.ok(node.name.length > 0);
  }
  assert.equal(softwareApplicationJsonLd().applicationCategory, "BusinessApplication");
});

test("BreadcrumbList uses apex item URLs", () => {
  const crumbs = breadcrumbListJsonLd([
    { name: "Home", path: "/" },
    { name: "Platforms", path: "/platforms" },
    { name: "Grok Bot", path: "/platforms/grok" },
  ]);
  assert.equal(crumbs["@type"], "BreadcrumbList");
  assert.equal(crumbs.itemListElement.length, 3);
  assert.equal(crumbs.itemListElement[2].item, "https://jobappagent.com/platforms/grok");
  assert.equal(crumbs.itemListElement[2].position, 3);
});

test("stats sitemap and robots stay on the stats host", () => {
  const xml = statsSitemapXml();
  assert.match(xml, /https:\/\/stats\.jobappagent\.com\//);
  assert.doesNotMatch(xml, /https:\/\/jobappagent\.com(?!\/)/);
  assert.doesNotMatch(xml, /jobappagent\.com\/platforms/);

  const robots = statsRobotsTxt();
  assert.match(robots, /Sitemap: https:\/\/stats\.jobappagent\.com\/sitemap\.xml/);
  assert.match(robots, /Host: https:\/\/stats\.jobappagent\.com/);
});

test("/open-source SoftwareApplication JSON-LD names JobAppAgent, MIT, repo, and has no price", () => {
  const node = openSourceSoftwareJsonLd();
  assert.equal(node["@type"], "SoftwareApplication");
  assert.equal(node.name, "JobAppAgent");
  assert.equal(node.alternateName, "job-application-agent");
  assert.equal(node.codeRepository, "https://github.com/vaibhavarora14/job-application-agent");
  assert.equal(node.applicationCategory, "DeveloperApplication");
  assert.match(node.license, /MIT/);
  const serialized = JSON.stringify(node);
  assert.doesNotMatch(serialized, /"offers"|"price"|\$49|beta/i);
});
