"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { usePublishedJobs } from "./usePublishedJobs";
import { searchJobs } from "../../lib/jobs-search.mjs";
import type { CommunityJob } from "../components/useCommunityJobs";
import styles from "./jobs.module.css";

export function PublishedJobs() {
  const { jobs, loading, error, retry } = usePublishedJobs();
  const [query, setQuery] = useState("");
  const [company, setCompany] = useState("");
  const [channel, setChannel] = useState("");
  const [sort, setSort] = useState("newest");
  const [visible, setVisible] = useState(25);
  const companies = useMemo(() => [...new Set(jobs.map(job => job.company))].sort(), [jobs]);
  const channels = useMemo(() => [...new Set(jobs.map(job => job.applicationChannel))].sort(), [jobs]);
  const results: CommunityJob[] = useMemo(() => searchJobs(jobs, { query, company, channel, sort }), [jobs, query, company, channel, sort]);
  const filtered = Boolean(query || company || channel);
  const clear = () => { setQuery(""); setCompany(""); setChannel(""); setVisible(25); };

  return <main className={`page-width ${styles.page}`}>
    <Link className={styles.back} href="/community-view">← Back to community stats</Link>
    <header className={styles.header}>
      <p className="eyebrow">Community directory · unlisted</p>
      <h1>Published jobs</h1>
      <p>Find your next opportunity. Community-sourced listings reviewed for publication—not placements or jobs secured. Check the linked page for current availability and requirements.</p>
    </header>
    <section className={styles.filters} aria-label="Search and filter published jobs">
      <label className={styles.search}>Search jobs
        <input type="search" placeholder="Role, company, or website…" value={query} disabled={loading || error} onChange={event => { setQuery(event.target.value); setVisible(25); }} />
      </label>
      <div className={styles.filterRow}>
        <label>Company<select aria-label="Company" value={company} disabled={loading || error} onChange={event => { setCompany(event.target.value); setVisible(25); }}><option value="">All companies</option>{companies.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Application channel<select aria-label="Application channel" value={channel} disabled={loading || error} onChange={event => { setChannel(event.target.value); setVisible(25); }}><option value="">All channels</option>{channels.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Sort by<select aria-label="Sort by" value={sort} onChange={event => { setSort(event.target.value); setVisible(25); }}><option value="newest">Newest first seen</option><option value="oldest">Oldest first seen</option><option value="company">Company A–Z</option></select></label>
      </div>
      <p className={styles.hint}>Search covers every published listing. Combine words to narrow your results.</p>
    </section>
    <div className={styles.summary} role="status" aria-live="polite">
      <span>{loading ? "Loading published jobs…" : error ? "Search unavailable" : `${results.length} ${results.length === 1 ? "job" : "jobs"}${filtered ? ` matching · ${jobs.length} total` : " available"}`}</span>
      {filtered && <button className={styles.clear} onClick={clear}>Clear filters</button>}
    </div>
    {loading && <div className={styles.skeleton} aria-hidden="true"><div /><div /><div /></div>}
    {error && <div className={styles.notice} role="alert"><p>We couldn’t load the complete directory. Retry to search all published jobs.</p><button className="button button-secondary" onClick={retry}>Retry</button></div>}
    {!loading && !error && results.length === 0 && <div className={styles.notice}><h2>{filtered ? "No matching jobs" : "No published jobs yet"}</h2><p>{filtered ? "Try fewer words or a different company or channel." : "Check back later for new opportunities."}</p>{filtered && <button className="button button-secondary" onClick={clear}>Clear filters</button>}</div>}
    {results.length > 0 && <ul className={styles.list} aria-label="Published job listings">
      {results.slice(0, visible).map(job => <li key={job.jobId} className={styles.job}>
        <div><p className={styles.company}>{job.company}</p><h2><a href={job.url} target="_blank" rel="noopener noreferrer">{job.role}<span aria-hidden="true"> ↗</span><span className={styles.srOnly}> (opens in a new tab)</span></a></h2>
          <p className={styles.meta}>{new URL(job.url).hostname} · First seen <time dateTime={job.firstSeenAt}>{job.firstSeenAt.slice(0, 10)}</time></p></div>
        <span className={styles.channel}>{job.applicationChannel}</span>
      </li>)}
    </ul>}
    {!loading && !error && results.length > 0 && <div className={styles.actions}>
      <p>Showing {Math.min(visible, results.length)} of {results.length} results</p>
      {visible < results.length && <button className="button button-secondary" onClick={() => setVisible(value => value + 25)}>Show more jobs</button>}
    </div>}
    <footer className={styles.footer}>Accessible by direct link. This page is unlisted, not private.</footer>
  </main>;
}
