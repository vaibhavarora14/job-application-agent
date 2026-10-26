"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  classifyRoleFamily,
  filterBoardJobs,
  formatReviewedDate,
  locationLabel,
} from "../../lib/live-jobs.mjs";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import styles from "./jobs.module.css";

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
    workplace?: string;
    employmentType?: string;
  } | null;
};

function JobApplyLink({ job }: { job: BoardJob }) {
  // List rows use outline secondary so role titles stay dominant on phone;
  // the solid primary CTA stays on /jobs/[slug].
  return (
    <Link href={`/jobs/${job.slug}`} className={`button button-secondary ${styles.rowApply}`}>
      Apply with your agent
    </Link>
  );
}

function DesktopRow({ job }: { job: BoardJob }) {
  return (
    <div className={styles.jobRow}>
      <span className={styles.company}>{job.company}</span>
      <span className={styles.title}>{job.role}</span>
      <span className={styles.location}>{locationLabel(job) || "—"}</span>
      <span className={styles.metaDate}>
        Reviewed {formatReviewedDate(job.lastCheckedAt ?? job.lastSeenAt)}
      </span>
      <JobApplyLink job={job} />
    </div>
  );
}

function MobileCard({ job }: { job: BoardJob }) {
  return (
    <div className={styles.mobileCard}>
      <p className={styles.mobileTitle}>{job.role}</p>
      <p className={styles.mobileMeta}>
        {job.company}
        {locationLabel(job) ? ` · ${locationLabel(job)}` : ""}
        <br />
        <span className={styles.metaDate}>Reviewed {formatReviewedDate(job.lastCheckedAt ?? job.lastSeenAt)}</span>
      </p>
      <JobApplyLink job={job} />
    </div>
  );
}

export function JobsBoard({
  jobs,
  checkedAtLabel,
}: {
  jobs: BoardJob[];
  checkedAtLabel: string;
}) {
  // Default "Any time": registry firstSeenAt is often weeks old even for freshly
  // verified-open roles, so "Last 14 days" hid the whole board after liveness landed.
  const [role, setRole] = useState("");
  const [location, setLocation] = useState("");
  const [postedDays, setPostedDays] = useState("0");

  const roleOptions = useMemo(() => {
    const set = new Set(jobs.map((job) => classifyRoleFamily(job.role)));
    return [...set].sort();
  }, [jobs]);

  const locationOptions = useMemo(() => {
    const set = new Set(jobs.map((job) => locationLabel(job)).filter(Boolean));
    return [...set].sort();
  }, [jobs]);

  const filtered = useMemo(
    () => filterBoardJobs(jobs, { role, location, postedDays: Number(postedDays) || 0 }),
    [jobs, role, location, postedDays],
  );

  const widenHint = useMemo(() => {
    if (filtered.length > 0 || postedDays === "0") return null;
    const anyTime = filterBoardJobs(jobs, { role, location, postedDays: 0 });
    if (anyTime.length === 0) return null;
    const label = role ? `${role} role${anyTime.length === 1 ? "" : "s"}` : `open role${anyTime.length === 1 ? "" : "s"}`;
    return `${anyTime.length} ${label} are available if you set Posted to Any time`;
  }, [filtered.length, jobs, role, location, postedDays]);

  const clear = () => {
    setRole("");
    setLocation("");
    setPostedDays("0");
  };

  const filtersActive = Boolean(role || location || postedDays !== "0");
  const registryEmpty = jobs.length === 0;

  return (
    <div className={styles.container}>
      <SiteHeader foundingCta={false} />
      <main className={`page-width ${styles.page}`}>
        <header className={styles.header}>
          <h1>Open roles, reviewed.</h1>
          <p className={styles.promise}>
            Roles reviewed by maintainers. Closed roles drop off automatically.
          </p>
        </header>

        <div className={styles.filters} aria-label="Filter open roles">
          <label className={styles.filterPill}>
            <small>Role</small>
            <select aria-label="Role" value={role} onChange={(event) => setRole(event.target.value)}>
              <option value="">All roles</option>
              {roleOptions.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className={styles.filterPill}>
            <small>Location</small>
            <select aria-label="Location" value={location} onChange={(event) => setLocation(event.target.value)}>
              <option value="">Any location</option>
              {locationOptions.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className={styles.filterPill}>
            <small>Posted</small>
            <select aria-label="Posted" value={postedDays} onChange={(event) => setPostedDays(event.target.value)}>
              <option value="0">Any time</option>
              <option value="7">Last 7 days</option>
              <option value="14">Last 14 days</option>
              <option value="30">Last 30 days</option>
            </select>
          </label>
          <span className={styles.count} role="status">
            {filtered.length} open role{filtered.length === 1 ? "" : "s"}
            {checkedAtLabel ? ` · registry checked ${checkedAtLabel}` : ""}
          </span>
        </div>

        {filtered.length === 0 ? (
          <div className={styles.empty}>
            <h2>{registryEmpty ? "No open roles right now" : "No open roles match these filters."}</h2>
            <p>
              {registryEmpty
                ? "New listings appear here as maintainers review the community registry. You can still let the agent find roles for you."
                : <>
                    The registry is small and only lists roles a maintainer has checked.
                    {widenHint ? <> <strong>{widenHint}.</strong></> : null}
                  </>}
            </p>
            <div className={styles.emptyActions}>
              {registryEmpty ? (
                <a className="button" href="https://jobappagent.com/platforms">Install JobAppAgent</a>
              ) : null}
              {widenHint ? (
                <button type="button" className="button" onClick={() => setPostedDays("0")}>
                  Show any time
                </button>
              ) : null}
              {filtersActive ? (
                <button type="button" className="button button-secondary" onClick={clear}>
                  Clear filters
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className={styles.list} aria-label="Open roles">
            {filtered.map((job: BoardJob) => (
              <div key={job.jobId}>
                <DesktopRow job={job} />
                <MobileCard job={job} />
              </div>
            ))}
          </div>
        )}

        <p className={styles.foot}>
          Listings come from the community registry. A maintainer reviews each one before it appears.
          Know a role?{" "}
          <a href="https://github.com/onima-tech/job-application-agent/blob/main/job-application-agent/references/SOURCES.md">
            Submit it to the registry ↗
          </a>
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
