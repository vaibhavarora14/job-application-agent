import type { Metadata } from "next";
import { PublishedJobs } from "./PublishedJobs";
import locations from "../../data/job-locations.json";

export const metadata: Metadata = {
  title: "Published jobs",
  description: "Community-sourced job listings reviewed for publication.",
  robots: { index: false, follow: false },
  alternates: { canonical: "https://stats.jobappagent.com/jobs" },
};

export default function JobsPage() {
  return <PublishedJobs locationIndex={{ collectedAt: locations.collectedAt, records: locations.records }} />;
}
