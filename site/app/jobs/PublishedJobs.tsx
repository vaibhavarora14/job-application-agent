"use client";
import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePublishedJobs } from "./usePublishedJobs";
import { searchJobs } from "../../lib/jobs-search.mjs";
import { jobPagination } from "../../lib/jobs-pagination.mjs";
import type { CommunityJob } from "../components/useCommunityJobs";
import { attachLocations, countryLabel } from "../../lib/job-locations.mjs";
import type { JobLocation, LocationIndex } from "./location-types";
import styles from "./jobs.module.css";

export function PublishedJobs({ locationIndex }: { locationIndex: LocationIndex }) {
  const { jobs: publishedJobs, loading, error, retry } = usePublishedJobs();
  const jobs: (CommunityJob & { location: JobLocation | null })[] = useMemo(() => attachLocations(publishedJobs, locationIndex), [publishedJobs, locationIndex]);
  const [query, setQuery] = useState("");
  const [company, setCompany] = useState("");
  const [channel, setChannel] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState("");
  const [country, setCountry] = useState("");
  const [workplace, setWorkplace] = useState("");
  const countries = useMemo(() => [...new Set(jobs.flatMap(job => job.location?.countries ?? []))].sort((a, b) => countryLabel(a).localeCompare(countryLabel(b))), [jobs]);
  const companies = useMemo(() => [...new Set(jobs.map(job => job.company))].sort(), [jobs]);
  const channels = useMemo(() => [...new Set(jobs.map(job => job.applicationChannel))].sort(), [jobs]);
  const results: typeof jobs = useMemo(() => searchJobs(jobs, { query, company, channel, sort, location, country, workplace }), [jobs, query, company, channel, sort, location, country, workplace]);
  const filtered = Boolean(query || company || channel || location || country || workplace);
  const pagination = jobPagination(results.length, page);
  const changePage = (number: number) => {
    setPage(number);
    summaryRef.current?.focus({ preventScroll: true });
    summaryRef.current?.scrollIntoView({ block: "start" });
  };
  const clear = () => { setQuery(""); setCompany(""); setChannel(""); setLocation(""); setCountry(""); setWorkplace(""); setPage(1); };

  return <main className={`page-width ${styles.page}`}>
    <Link className={styles.back} href="/community-view">← Back to community stats</Link>
    <header className={styles.header}>
      <p className="eyebrow">Community directory · unlisted</p>
      <h1>Published jobs</h1>
      <p>Find your next opportunity. Community-sourced listings reviewed for publication—not placements or jobs secured. Check the linked page for current availability and requirements.</p>
    </header>
    <section className={styles.filters} aria-label="Search and filter published jobs">
      <label className={styles.search}>Search jobs
        <input type="search" placeholder="Role, company, or website…" value={query} disabled={loading || error} onChange={event => { setQuery(event.target.value); setPage(1); }} />
      </label>
      <div className={styles.filterRow}>
        <label>Location<input type="search" aria-label="Location" placeholder="City, region, or country…" value={location} disabled={loading || error} onChange={event => { setLocation(event.target.value); setPage(1); }} /></label>
        <label>Country / region<select aria-label="Country / region" value={country} disabled={loading || error} onChange={event => { setCountry(event.target.value); setPage(1); }}><option value="">All countries / regions</option>{countries.map(value => <option key={value} value={value}>{countryLabel(value)}</option>)}</select></label>
        <label>Work arrangement<select aria-label="Work arrangement" value={workplace} disabled={loading || error} onChange={event => { setWorkplace(event.target.value); setPage(1); }}><option value="">Any arrangement</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option><option value="unknown">Not specified</option></select></label>
      </div>
      <div className={styles.filterRow}>
        <label>Company<select aria-label="Company" value={company} disabled={loading || error} onChange={event => { setCompany(event.target.value); setPage(1); }}><option value="">All companies</option>{companies.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Application channel<select aria-label="Application channel" value={channel} disabled={loading || error} onChange={event => { setChannel(event.target.value); setPage(1); }}><option value="">All channels</option>{channels.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Sort by<select aria-label="Sort by" value={sort} onChange={event => { setSort(event.target.value); setPage(1); }}><option value="newest">Newest first seen</option><option value="oldest">Oldest first seen</option><option value="company">Company A–Z</option></select></label>
      </div>
      <p className={styles.hint}>Search covers every published listing. Combine words to narrow your results.</p>
      {!loading && !error && <p className={styles.hint}>Location or workplace data for {jobs.filter(job => job.location).length} of {jobs.length} listings · Checked {locationIndex.collectedAt.slice(0, 10)}. Country / region uses the employer’s structured address, not eligibility. Remote may have geographic restrictions.</p>}
    </section>
    <div ref={summaryRef} tabIndex={-1} className={styles.summary} role="status" aria-live="polite">
      <span>{loading ? "Loading published jobs…" : error ? "Search unavailable" : `${results.length} ${results.length === 1 ? "job" : "jobs"}${filtered ? ` matching · ${jobs.length} total` : " available"}`}</span>
      {!loading && !error && results.length > 0 && <span>Page {pagination.page} of {pagination.totalPages}</span>}
      {filtered && <button className={styles.clear} onClick={clear}>Clear filters</button>}
    </div>
    {loading && <div className={styles.skeleton} aria-hidden="true"><div /><div /><div /></div>}
    {error && <div className={styles.notice} role="alert"><p>We couldn’t load the complete directory. Retry to search all published jobs.</p><button className="button button-secondary" onClick={retry}>Retry</button></div>}
    {!loading && !error && results.length === 0 && <div className={styles.notice}><h2>{filtered ? "No matching jobs" : "No published jobs yet"}</h2><p>{filtered ? "Try fewer words or clear a filter. Listings without verified location data won’t match location or country filters." : "Check back later for new opportunities."}</p>{filtered && <button className="button button-secondary" onClick={clear}>Clear filters</button>}</div>}
    {results.length > 0 && <ul className={styles.list} aria-label="Published job listings">
      {results.slice(pagination.start, pagination.end).map(job => <li key={job.jobId} className={styles.job}>
        <div><p className={styles.company}>{job.company}</p><h2><a href={job.url} target="_blank" rel="noopener noreferrer">{job.role}<span aria-hidden="true"> ↗</span><span className={styles.srOnly}> (opens in a new tab)</span></a></h2>
          <p className={styles.location}>{job.location?.label || "Location not specified"} · {({ remote: "Remote", hybrid: "Hybrid", onsite: "On-site" } as Record<string, string>)[job.location?.workplace ?? ""] ?? "Work arrangement not specified"}</p>
          <p className={styles.meta}>{new URL(job.url).hostname} · First seen <time dateTime={job.firstSeenAt}>{job.firstSeenAt.slice(0, 10)}</time>{job.location && <> · Location checked <time dateTime={job.location.checkedAt}>{job.location.checkedAt.slice(0, 10)}</time></>}</p></div>
        <span className={styles.channel}>{job.applicationChannel}</span>
      </li>)}
    </ul>}
    {!loading && !error && results.length > 0 && <div className={styles.actions}>
      <p>Showing {pagination.start + 1}–{pagination.end} of {results.length} results</p>
      {pagination.totalPages > 1 && <nav className={styles.pagination} aria-label="Job results pages">
        <button disabled={pagination.page === 1} onClick={() => changePage(pagination.page - 1)}>Previous</button>
        {pagination.numbers.map(number => typeof number === "number"
          ? <button key={number} aria-label={`Page ${number}`} aria-current={number === pagination.page ? "page" : undefined} onClick={() => changePage(number)}>{number}</button>
          : <span key={number} aria-hidden="true">…</span>)}
        <button disabled={pagination.page === pagination.totalPages} onClick={() => changePage(pagination.page + 1)}>Next</button>
      </nav>}
    </div>}
    <footer className={styles.footer}>Accessible by direct link. This page is unlisted, not private.</footer>
  </main>;
}
