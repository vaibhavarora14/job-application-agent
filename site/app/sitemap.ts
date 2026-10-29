import type { MetadataRoute } from "next";
import catalog from "../../job-application-agent/platforms.json";
import { isListedOpenJob, jobSlug } from "../lib/live-jobs.mjs";

const siteUrl = "https://jobappagent.com";

async function jobEntries(): Promise<MetadataRoute.Sitemap> {
  try {
    const { loadLiveJobsSafe } = await import("../lib/fetch-live-jobs.mjs");
    const jobs = await loadLiveJobsSafe();
    const now = Date.now();
    return jobs
      .filter((job) => job.livenessStatus === "open" || job.livenessStatus === "closed")
      .filter((job) => {
        if (job.livenessStatus === "closed") return true;
        return isListedOpenJob(job, now);
      })
      .map((job) => ({
        url: `${siteUrl}/jobs/${job.slug ?? jobSlug(job)}`,
        lastModified: job.lastCheckedAt ?? job.lastSeenAt,
        changeFrequency: "daily" as const,
        priority: job.livenessStatus === "open" ? 0.7 : 0.3,
      }));
  } catch {
    return [];
  }
}

/** Apex sitemap only — stats.jobappagent.com has its own sitemap via host routing. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const jobs = await jobEntries();
  return [
    { url: siteUrl, changeFrequency: "weekly", priority: 1 },
    { url: `${siteUrl}/jobs`, changeFrequency: "daily", priority: 0.9 },
    ...jobs,
    { url: `${siteUrl}/open-source`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${siteUrl}/compare`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${siteUrl}/platforms`, changeFrequency: "monthly", priority: 0.6 },
    ...catalog.platforms.map(platform => ({ url: `${siteUrl}/platforms/${platform.id}`, changeFrequency: "monthly" as const, priority: 0.5 })),
    { url: `${siteUrl}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${siteUrl}/terms`, changeFrequency: "yearly", priority: 0.3 },
  ];
}
