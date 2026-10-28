import type { Metadata } from "next";
import { JobsBoard } from "./JobsBoard";
import { loadJobsBoard } from "../../lib/load-jobs-board.mjs";
import { TRUST_LINE } from "../../lib/live-jobs.mjs";
import { filterAndSortJobs, parseBoardQuery } from "../../lib/jobs-board-query.mjs";

export const dynamic = "force-dynamic";

const JOBS_TITLE = "Open roles";
const JOBS_DESCRIPTION = `Maintainer-reviewed open roles from the JobAppAgent community registry. ${TRUST_LINE}.`;
const JOBS_URL = "https://jobappagent.com/jobs";

export const metadata: Metadata = {
  title: JOBS_TITLE,
  description: JOBS_DESCRIPTION,
  alternates: { canonical: JOBS_URL },
  robots: { index: true, follow: true },
  openGraph: {
    title: `${JOBS_TITLE} · JobAppAgent`,
    description: JOBS_DESCRIPTION,
    url: JOBS_URL,
    type: "website",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "JobAppAgent open roles" }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${JOBS_TITLE} · JobAppAgent`,
    description: JOBS_DESCRIPTION,
    images: ["/og.png"],
  },
};

export async function headers() {
  return {
    "Cache-Control": "public, s-maxage=300, stale-while-revalidate=900",
  };
}

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default async function JobsPage({ searchParams }: Props) {
  const query = parseBoardQuery(searchParams ? await searchParams : undefined);
  const board = await loadJobsBoard();
  const now: number = board.now;
  const matches = filterAndSortJobs(board.open, query, now);
  return <JobsBoard query={query} allOpen={board.open} matches={matches} failed={Boolean(board.failed)} now={now} />;
}
