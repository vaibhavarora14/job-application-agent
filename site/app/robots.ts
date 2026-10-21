import type { MetadataRoute } from "next";

const siteUrl = "https://jobappagent.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/checkout/return"],
      // Each uncached /jobs/<slug> render is an SSR pass on the Workers Free plan
      // (10 ms CPU). On 2026-10-21 a robots-aware sitemap crawler fetching a page
      // every ~2 s drove the site into "exceeded CPU" errors. Crawlers that honour
      // Crawl-delay (Bing, Yandex, most SEO bots) slow to one page per 10 s;
      // Googlebot ignores it, so Google indexing is unaffected.
      crawlDelay: 10,
    },
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
