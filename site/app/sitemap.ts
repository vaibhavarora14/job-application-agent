import type { MetadataRoute } from "next";
import catalog from "../../job-application-agent/platforms.json";

const siteUrl = "https://jobappagent.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/platforms`, changeFrequency: "monthly", priority: 0.6 },
    ...catalog.platforms.map(platform => ({ url: `${siteUrl}/platforms/${platform.id}`, changeFrequency: "monthly" as const, priority: 0.5 })),
    { url: "https://stats.jobappagent.com", changeFrequency: "daily", priority: 0.8 },
    { url: `${siteUrl}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${siteUrl}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
