import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { JobDetail } from "../JobDetail";
import { loadJobPageBySlug } from "../../../lib/job-page-data.mjs";
import { jobPostingJsonLd, TRUST_LINE } from "../../../lib/live-jobs.mjs";

type Props = { params: Promise<{ slug: string }> };

export const dynamic = "force-dynamic";

export async function headers() {
  return {
    "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
  };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await loadJobPageBySlug(slug);
  // Missing / stale-open → notFound(); leave robots to app/not-found.tsx to avoid duplicate metas.
  if (!page) return { title: "Role not found" };

  const { job } = page;
  const closed = job.livenessStatus === "closed";
  const title = closed ? `${job.role} (closed)` : job.role;
  const description = closed
    ? `${job.role} at ${job.company} is closed.`
    : `${job.role} at ${job.company}. ${TRUST_LINE}.`;
  const url = `https://jobappagent.com/jobs/${job.slug}`;
  return {
    title,
    description,
    alternates: { canonical: url },
    robots: { index: true, follow: true },
    openGraph: {
      title: `${title} · JobAppAgent`,
      description,
      url,
      type: "website",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: `${job.role} at ${job.company}` }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${title} · JobAppAgent`,
      description,
      images: ["/og.png"],
    },
  };
}

export function generateStaticParams() {
  return [];
}

export default async function JobPage({ params }: Props) {
  const { slug } = await params;
  const page = await loadJobPageBySlug(slug);
  if (!page) notFound();

  const { job, similar } = page;
  const jsonLd = jobPostingJsonLd(job);

  return <JobDetail job={job} similar={similar} jsonLd={jsonLd} />;
}
