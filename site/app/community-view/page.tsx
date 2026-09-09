import type { Metadata } from "next";
import { CommunityDashboard } from "../components/CommunityDashboard";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

export const metadata: Metadata = {
  title: "Community stats",
  description: "Anonymous community activity from Job Application Agent: active installations, jobs assessed, and verified applications.",
  alternates: { canonical: "https://stats.jobappagent.com/" },
};

export default function CommunityPage() {
  return <><SiteHeader community /><CommunityDashboard /><SiteFooter community /></>;
}
