import type { Metadata } from "next";
import { PublishedJobs } from "./PublishedJobs";

export const metadata: Metadata = {
  title: "Published jobs",
  description: "Community-sourced job listings reviewed for publication.",
  robots: { index: false, follow: false },
  alternates: { canonical: "https://stats.jobappagent.com/jobs" },
};

export default function JobsPage() {
  return <PublishedJobs />;
}
