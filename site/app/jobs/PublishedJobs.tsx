"use client";

import { useCommunityJobs } from "../components/useCommunityJobs";
import Link from "next/link";
import styles from "./jobs.module.css";

export function PublishedJobs() {
  const { jobs, nextCursor, loading, loadingMore, error, loadMore } = useCommunityJobs();
  return <main className={`page-width ${styles.page}`}>
    <Link className={styles.back} href="/community-view">← Back to community stats</Link>
    <header className={styles.header}>
      <p className="eyebrow">Community directory · unlisted</p>
      <h1>Published jobs</h1>
      <p>Community-sourced listings reviewed for publication. These are opportunities, not placements or jobs secured. Check the linked page for current availability and requirements.</p>
    </header>
    <div className={styles.summary} role="status" aria-live="polite">
      {loading ? "Loading published jobs…" : `${jobs.length} listings loaded${nextCursor ? " · more available" : ""}`}
    </div>
    {loading && <div className={styles.skeleton} aria-hidden="true"><div /><div /><div /></div>}
    {!loading && !error && jobs.length === 0 && <p className={styles.notice}>No published jobs yet. Check back later.</p>}
    {jobs.length > 0 && <ul className={styles.list} aria-label="Published job listings">
      {jobs.map(job => <li key={job.jobId} className={styles.job}>
        <div>
          <p className={styles.company}>{job.company}</p>
          <h2><a href={job.url} target="_blank" rel="noopener noreferrer">{job.role}<span aria-hidden="true"> ↗</span><span className={styles.srOnly}> (opens in a new tab)</span></a></h2>
          <p className={styles.meta}>{new URL(job.url).hostname} · First seen <time dateTime={job.firstSeenAt}>{job.firstSeenAt.slice(0, 10)}</time></p>
        </div>
        <span className={styles.channel}>{job.applicationChannel}</span>
      </li>)}
    </ul>}
    {error && <p role="alert" className={styles.notice}>{jobs.length ? "The next page couldn’t be loaded. Your current listings are still here." : "Published jobs are temporarily unavailable."}</p>}
    <div className={styles.actions}>
      {error && jobs.length === 0 ? <button className="button button-secondary" onClick={() => window.location.reload()}>Retry</button> : nextCursor && <button className="button button-secondary" disabled={loadingMore} onClick={loadMore}>{loadingMore ? "Loading…" : error ? "Retry loading more" : "Load more jobs"}</button>}
      {!loading && !nextCursor && jobs.length > 0 && <p>All published listings loaded.</p>}
    </div>
    <footer className={styles.footer}>Accessible by direct link. This page is unlisted, not private.</footer>
  </main>;
}
