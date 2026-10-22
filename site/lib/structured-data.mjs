/** Schema.org JSON-LD helpers for the public site. Facts only — no offers/price. */

export const SITE_ORIGIN = "https://jobappagent.com";
export const STATS_ORIGIN = "https://stats.jobappagent.com";
export const GITHUB_URL = "https://github.com/vaibhavarora14/job-application-agent";

const ORGANIZATION_ID = `${SITE_ORIGIN}/#organization`;
const WEBSITE_ID = `${SITE_ORIGIN}/#website`;
const SOFTWARE_ID = `${SITE_ORIGIN}/#software`;

/** @returns {Record<string, unknown>} */
export function organizationJsonLd() {
  return {
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: "JobAppAgent",
    alternateName: "Job Application Agent",
    url: SITE_ORIGIN,
    logo: `${SITE_ORIGIN}/icon-512.png`,
    sameAs: [GITHUB_URL],
  };
}

/** @returns {Record<string, unknown>} */
export function websiteJsonLd() {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: "JobAppAgent",
    url: SITE_ORIGIN,
    description:
      "A calmer way to job hunt. JobAppAgent keeps disciplined, truthful applications moving inside boundaries you control.",
    publisher: { "@id": ORGANIZATION_ID },
  };
}

/**
 * SoftwareApplication without offers/price — founding reservation is not listed as a product offer here.
 * @returns {Record<string, unknown>}
 */
export function softwareApplicationJsonLd() {
  // Intentionally omit offers/price — founding reservation is not a schema.org Offer here.
  return {
    "@type": "SoftwareApplication",
    "@id": SOFTWARE_ID,
    name: "Job Application Agent",
    alternateName: "JobAppAgent",
    url: SITE_ORIGIN,
    description:
      "A disciplined job-search agent that discovers, qualifies, applies, pauses for judgment, and keeps a verified record while you are away.",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    publisher: { "@id": ORGANIZATION_ID },
  };
}

/**
 * /open-source page: SoftwareApplication for the open-source package. No offers/price.
 * @returns {Record<string, unknown>}
 */
export function openSourceSoftwareJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "JobAppAgent",
    alternateName: "job-application-agent",
    description:
      "JobAppAgent is an open-source job application agent (MIT). It applies from one verified résumé within your rules. By default you approve each submit.",
    url: `${SITE_ORIGIN}/open-source`,
    license: "https://opensource.org/licenses/MIT",
    codeRepository: GITHUB_URL,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Windows, Linux",
    publisher: { "@id": ORGANIZATION_ID },
  };
}

/** Root-layout graph: Organization + WebSite + SoftwareApplication (no price). */
export function siteJsonLdGraph() {
  return {
    "@context": "https://schema.org",
    "@graph": [organizationJsonLd(), websiteJsonLd(), softwareApplicationJsonLd()],
  };
}

/**
 * @param {{ name: string, path: string }[]} crumbs Absolute apex paths preferred.
 * @returns {Record<string, unknown>}
 */
export function breadcrumbListJsonLd(crumbs) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: crumb.path.startsWith("http") ? crumb.path : `${SITE_ORIGIN}${crumb.path}`,
    })),
  };
}

/** Stats-subdomain sitemap body (host-local URLs only). */
export function statsSitemapXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url>
<loc>${STATS_ORIGIN}/</loc>
<changefreq>daily</changefreq>
<priority>0.8</priority>
</url>
</urlset>
`;
}

/** Stats-subdomain robots.txt pointing at its own sitemap. */
export function statsRobotsTxt() {
  return ["User-Agent: *", "Allow: /", "Disallow: /api/", `Host: ${STATS_ORIGIN}`, `Sitemap: ${STATS_ORIGIN}/sitemap.xml`, ""].join(
    "\n",
  );
}
