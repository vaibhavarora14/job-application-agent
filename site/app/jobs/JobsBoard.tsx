import Link from "next/link";
import {
  JOBS_PAGE_SIZE,
  boardHref,
  emptyBoardQuery,
  likelyZeroCause,
} from "../../lib/jobs-board-query.mjs";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import { BoardFrame } from "./BoardFilters";
import { JobRow } from "./JobRow";
import styles from "./jobs.module.css";
import type { JobSalary } from "./location-types";

export type BoardJob = {
  jobId: string;
  slug: string;
  url: string;
  company: string;
  role: string;
  applicationChannel: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckedAt: string | null;
  livenessStatus: "open" | "closed" | "unknown";
  location?: {
    label?: string;
    cities?: string[];
    countries?: string[];
    countryCodes?: string[];
    places?: { locality?: string; region?: string; country: string }[];
    workplace?: string;
    employmentType?: string | null;
    experienceLevel?: string | null;
    salary?: JobSalary | null;
    department?: string | null;
    team?: string | null;
    postedAt?: string | null;
  } | null;
};

type BoardQuery = ReturnType<typeof emptyBoardQuery>;

function ZeroState({ query, allOpen, now }: { query: BoardQuery; allOpen: BoardJob[]; now: number }) {
  if (allOpen.length === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.eT}>No open roles right now</p>
        <p className={styles.eB}>New listings appear here as maintainers review the community registry.</p>
        <div className={styles.eA}>
          <a className={`${styles.btn} ${styles.pri}`} href="https://jobappagent.com/platforms">Install JobAppAgent</a>
        </div>
      </div>
    );
  }
  const cause = likelyZeroCause(allOpen, query, now);
  return (
    <div className={styles.empty}>
      <p className={styles.eT}>No roles match these filters</p>
      {cause ? (
        <>
          <p className={styles.eB}>
            {`“${cause.chip.label}” rules out every match. Without it, ${cause.count} role${cause.count === 1 ? "" : "s"} match.`}
          </p>
          <div className={styles.eA}>
            <Link className={`${styles.btn} ${styles.pri}`} href={boardHref(cause.chip.query)} scroll={false}>
              {`Remove “${cause.chip.label}”`}
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className={styles.eB}>No single filter is the cause. Clear them to see all open roles.</p>
          <div className={styles.eA}>
            <Link className={`${styles.btn} ${styles.pri}`} href="/jobs" scroll={false}>Clear filters</Link>
          </div>
        </>
      )}
    </div>
  );
}

function ErrorState({ query }: { query: BoardQuery }) {
  return (
    <div className={`${styles.empty} ${styles.err}`} role="alert">
      <p className={styles.eT}>We couldn&apos;t load the role list</p>
      <p className={styles.eB}>Our server could not reach the registry. Your filters are saved in the link.</p>
      <div className={styles.eA}>
        <a className={`${styles.btn} ${styles.pri}`} href={boardHref({ ...query, design: null }, { keepShow: true })}>Try again</a>
      </div>
    </div>
  );
}

export function JobsBoard({
  query,
  allOpen,
  matches,
  failed,
  now,
}: {
  query: BoardQuery;
  /** Every listed-open role (for totals and zero-state diagnosis). */
  allOpen: BoardJob[];
  /** Roles matching the query, newest posted first. */
  matches: BoardJob[];
  failed: boolean;
  now: number;
}) {
  const shown = matches.slice(0, query.show);
  const more = Math.min(JOBS_PAGE_SIZE, matches.length - shown.length);
  const showError = failed || query.design === "error";

  return (
    <div className={styles.container}>
      <SiteHeader foundingCta={false} />
      <main className={`page-width ${styles.page}`}>
        <header className={styles.phead}>
          <h1>Open roles, reviewed.</h1>
          <p>Roles reviewed by maintainers. Closed roles drop off automatically.</p>
        </header>
        <BoardFrame query={query} total={allOpen.length} matched={matches.length} failed={showError}>
          {showError ? (
            <ErrorState query={query} />
          ) : shown.length === 0 ? (
            <ZeroState query={query} allOpen={allOpen} now={now} />
          ) : (
            <>
              <div className={styles.list}>
                {shown.map((job) => <JobRow key={job.jobId} job={job} now={now} />)}
              </div>
              <div className={styles.pager}>
                <span>{`Showing ${shown.length} of ${matches.length}`}</span>
                {more > 0 ? (
                  <Link
                    className={`${styles.btn} ${styles.btn2}`}
                    href={boardHref({ ...query, show: query.show + JOBS_PAGE_SIZE }, { keepShow: true })}
                    scroll={false}
                  >
                    {`Show ${more} more`}
                  </Link>
                ) : null}
              </div>
            </>
          )}
        </BoardFrame>
        <p className={styles.foot}>
          Know a role?{" "}
          <a href="https://github.com/vaibhavarora14/job-application-agent/blob/main/job-application-agent/references/SOURCES.md">
            Submit it to the registry ↗
          </a>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
