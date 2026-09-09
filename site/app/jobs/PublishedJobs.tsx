"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { SiteHeader, SiteFooter } from "../components/SiteChrome";
import { usePublishedJobs } from "./usePublishedJobs";
import { searchJobs } from "../../lib/jobs-search.mjs";
import { jobPagination } from "../../lib/jobs-pagination.mjs";
import type { CommunityJob } from "../components/useCommunityJobs";
import { attachLocations, countryLabel, estimateBenchmarkSalary, extractEmploymentType, extractExperienceLevel } from "../../lib/job-locations.mjs";
import type { JobLocation, LocationIndex } from "./location-types";
import styles from "./jobs.module.css";

function formatRelativeDate(isoDate: string): string {
  try {
    const target = Date.parse(isoDate);
    if (isNaN(target)) return isoDate.slice(0, 10);
    const now = Date.now();
    const diffDays = Math.floor((now - target) / 86400000);
    if (diffDays <= 0) return "First seen today";
    if (diffDays === 1) return "First seen yesterday";
    if (diffDays < 30) return `First seen ${diffDays}d ago`;
    return `First seen ${new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(target))}`;
  } catch {
    return `First seen ${isoDate.slice(0, 10)}`;
  }
}

function getHostname(urlStr: string): string {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function getWorkplaceMeta(workplace?: string) {
  switch (workplace) {
    case "remote":
      return { label: "Remote", className: styles.badgeRemote, icon: "●" };
    case "hybrid":
      return { label: "Hybrid", className: styles.badgeHybrid, icon: "◑" };
    case "onsite":
      return { label: "On-site", className: styles.badgeOnsite, icon: "○" };
    default:
      return null;
  }
}

const AVATAR_PALETTES = [
  { bg: "#EBF3EF", color: "#1E4A3E", border: "#c2ddd0" },
  { bg: "#F5EFE6", color: "#4B3D2B", border: "#ded3c2" },
  { bg: "#EBF1F7", color: "#253F59", border: "#c8d8e8" },
  { bg: "#F1EBE5", color: "#3B4A3F", border: "#d7cdc2" },
  { bg: "#E5ECE9", color: "#173F35", border: "#bfd4cb" },
];

function getAvatarStyle(company: string) {
  let hash = 0;
  for (let i = 0; i < company.length; i++) {
    hash = (hash << 5) - hash + company.charCodeAt(i);
  }
  const idx = Math.abs(hash) % AVATAR_PALETTES.length;
  return AVATAR_PALETTES[idx];
}

export function PublishedJobs({ locationIndex }: { locationIndex: LocationIndex }) {
  const { jobs: publishedJobs, loading, error, retry } = usePublishedJobs();
  const jobs: (CommunityJob & { location: JobLocation | null })[] = useMemo(() => attachLocations(publishedJobs, locationIndex), [publishedJobs, locationIndex]);
  const [query, setQuery] = useState("");
  const [company, setCompany] = useState("");
  const [channel, setChannel] = useState("");
  const [sort, setSort] = useState("newest");
  const [page, setPage] = useState(1);
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState("");
  const [country, setCountry] = useState("");
  const [workplace, setWorkplace] = useState("");
  const [salaryMin, setSalaryMin] = useState("");
  const [employmentType, setEmploymentType] = useState("");
  const [experienceLevel, setExperienceLevel] = useState("");
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "/" && document.activeElement !== searchInputRef.current && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName ?? "")) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const copyJobLink = async (job: CommunityJob) => {
    try {
      await navigator.clipboard.writeText(job.url);
      setCopiedJobId(job.jobId);
      setTimeout(() => setCopiedJobId((current) => (current === job.jobId ? null : current)), 2000);
    } catch {
      // Fallback
    }
  };

  const countries = useMemo(() => [...new Set(jobs.flatMap(job => job.location?.countries ?? []))].sort((a, b) => countryLabel(a).localeCompare(countryLabel(b))), [jobs]);
  const companies = useMemo(() => [...new Set(jobs.map(job => job.company))].sort(), [jobs]);
  const channels = useMemo(() => [...new Set(jobs.map(job => job.applicationChannel))].sort(), [jobs]);
  const results: typeof jobs = useMemo(() => searchJobs(jobs, {
    query,
    company,
    channel,
    sort,
    location,
    country,
    workplace,
    salaryMin: salaryMin ? Number(salaryMin) : 0,
    employmentType,
    experienceLevel
  }), [jobs, query, company, channel, sort, location, country, workplace, salaryMin, employmentType, experienceLevel]);
  const filtered = Boolean(query || company || channel || location || country || workplace || salaryMin || employmentType || experienceLevel);
  const pagination = jobPagination(results.length, page);

  const changePage = (number: number) => {
    setPage(number);
    summaryRef.current?.focus({ preventScroll: true });
    summaryRef.current?.scrollIntoView({ block: "start" });
  };

  const clear = () => {
    setQuery("");
    setCompany("");
    setChannel("");
    setLocation("");
    setCountry("");
    setWorkplace("");
    setSalaryMin("");
    setEmploymentType("");
    setExperienceLevel("");
    setPage(1);
  };

  const toggleWorkplacePill = (val: string) => {
    setWorkplace(current => current === val ? "" : val);
    setPage(1);
  };

  const toggleChannelPill = (val: string) => {
    setChannel(current => current === val ? "" : val);
    setPage(1);
  };

  const toggleSalaryPill = (val: string) => {
    setSalaryMin(current => current === val ? "" : val);
    setPage(1);
  };

  const toggleEmploymentPill = (val: string) => {
    setEmploymentType(current => current === val ? "" : val);
    setPage(1);
  };

  const advancedActiveCount = (location ? 1 : 0) + (country ? 1 : 0) + (company ? 1 : 0) + (sort !== "newest" ? 1 : 0) + (salaryMin ? 1 : 0) + (employmentType ? 1 : 0) + (experienceLevel ? 1 : 0);
  const isAdvancedOpen = showAdvancedFilters || advancedActiveCount > 0;

  const verifiedLocationsCount = jobs.filter(job => job.location).length;


  return (
    <div className={styles.container}>
      <SiteHeader community />
      <main className={`page-width ${styles.page}`}>
        <div className={styles.breadcrumbBar}>
          <Link className={styles.back} href="/community-view">← Back to community stats</Link>
        </div>

        <header className={styles.header}>
          <div className={styles.headerTitleGroup}>
            <p className="eyebrow">Community directory · unlisted</p>
            <h1>Published jobs</h1>
          </div>
          <p className={styles.headerLead}>
            Find your next opportunity. Community-sourced listings reviewed for publication—not placements or jobs secured. Check the linked page for current availability and requirements.
          </p>
          <div className={styles.statsRow}>
            <span className={`${styles.statPill} ${styles.statPillActive}`}>
              <span className={styles.statDot} aria-hidden="true" />
              {jobs.length > 0 ? `${jobs.length} verified listings` : "Direct ATS listings"}
            </span>
            <span className={styles.statPill}>Greenhouse · Ashby · Lever · Workable</span>
            <span className={styles.statPill}>Zero recruiter spam · Zero sponsored slots</span>
          </div>
        </header>

        <section className={styles.filtersCard} aria-label="Search and filter published jobs">
          <div className={styles.searchWrapper}>
            <svg className={styles.searchIcon} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4.5 4.5" />
            </svg>
            <input
              ref={searchInputRef}
              className={styles.searchInput}
              type="search"
              aria-label="Search jobs"
              placeholder="Search by role, company, or keyword (e.g. Staff, Python, Anthropic)…"
              value={query}
              disabled={loading || error}
              onChange={event => { setQuery(event.target.value); setPage(1); }}
            />
            <div className={styles.searchControls}>
              {query && (
                <button
                  type="button"
                  className={styles.clearSearchBtn}
                  onClick={() => { setQuery(""); setPage(1); searchInputRef.current?.focus(); }}
                  aria-label="Clear search input"
                >
                  ✕
                </button>
              )}
              <kbd className={styles.kbdShortcut} title="Press / to search">/</kbd>
            </div>
          </div>

          <div className={styles.quickFiltersRow} aria-label="Quick filters">
            <span className={styles.quickFilterLabel}>Quick filters:</span>
            <button
              type="button"
              className={`${styles.quickPill} ${!workplace && !channel ? styles.quickPillActive : ""}`}
              onClick={() => { setWorkplace(""); setChannel(""); setPage(1); }}
            >
              All roles
            </button>
            <button
              type="button"
              className={`${styles.quickPill} ${workplace === "remote" ? styles.quickPillActive : ""}`}
              onClick={() => toggleWorkplacePill("remote")}
            >
              ● Remote only
            </button>
            <button
              type="button"
              className={`${styles.quickPill} ${workplace === "hybrid" ? styles.quickPillActive : ""}`}
              onClick={() => toggleWorkplacePill("hybrid")}
            >
              ◑ Hybrid
            </button>
            <button
              type="button"
              className={`${styles.quickPill} ${workplace === "onsite" ? styles.quickPillActive : ""}`}
              onClick={() => toggleWorkplacePill("onsite")}
            >
              ○ On-site
            </button>
            <button
              type="button"
              className={`${styles.quickPill} ${channel === "greenhouse" ? styles.quickPillActive : ""}`}
              onClick={() => toggleChannelPill("greenhouse")}
            >
              Greenhouse
            </button>
            <button
              type="button"
              className={`${styles.quickPill} ${channel === "ashby" ? styles.quickPillActive : ""}`}
              onClick={() => toggleChannelPill("ashby")}
            >
              Ashby
            </button>
            <button
              type="button"
              className={`${styles.quickPill} ${channel === "lever" ? styles.quickPillActive : ""}`}
              onClick={() => toggleChannelPill("lever")}
            >
              Lever
            </button>
            <button
              type="button"
              className={`${styles.quickPill} ${salaryMin === "150000" ? styles.quickPillActive : ""}`}
              onClick={() => toggleSalaryPill("150000")}
            >
              $150k+ salary
            </button>
            <button
              type="button"
              className={`${styles.quickPill} ${employmentType === "internship" ? styles.quickPillActive : ""}`}
              onClick={() => toggleEmploymentPill("internship")}
            >
              Internships
            </button>
          </div>

          <div className={styles.filtersToggleRow}>
            <button
              type="button"
              className={styles.filterToggleBtn}
              onClick={() => setShowAdvancedFilters(prev => !prev)}
              aria-expanded={isAdvancedOpen}
              aria-controls="advanced-filters"
            >
              <span>{isAdvancedOpen ? "Fewer filters" : "More filters"}</span>
              {advancedActiveCount > 0 && (
                <span className={styles.filterToggleBadge}>
                  {advancedActiveCount}
                </span>
              )}
              <svg
                className={`${styles.toggleChevron} ${isAdvancedOpen ? styles.toggleChevronOpen : ""}`}
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708z" />
              </svg>
            </button>
          </div>

          {isAdvancedOpen && (
            <div id="advanced-filters" className={styles.filterGrid}>
              <div className={styles.filterField}>
                <label htmlFor="filter-location" className={styles.fieldLabel}>Location</label>
                <input
                  id="filter-location"
                  className={styles.textInput}
                  type="search"
                  aria-label="Location"
                  placeholder="City, region, or country…"
                  value={location}
                  disabled={loading || error}
                  onChange={event => { setLocation(event.target.value); setPage(1); }}
                />
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filter-country" className={styles.fieldLabel}>Country / region</label>
                <select
                  id="filter-country"
                  className={styles.selectInput}
                  aria-label="Country / region"
                  value={country}
                  disabled={loading || error}
                  onChange={event => { setCountry(event.target.value); setPage(1); }}
                >
                  <option value="">All countries / regions</option>
                  {countries.map(value => <option key={value} value={value}>{countryLabel(value)}</option>)}
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filter-workplace" className={styles.fieldLabel}>Work arrangement</label>
                <select
                  id="filter-workplace"
                  className={styles.selectInput}
                  aria-label="Work arrangement"
                  value={workplace}
                  disabled={loading || error}
                  onChange={event => { setWorkplace(event.target.value); setPage(1); }}
                >
                  <option value="">Any arrangement</option>
                  <option value="remote">Remote</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="onsite">On-site</option>
                  <option value="unknown">Not specified</option>
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filter-salary" className={styles.fieldLabel}>Min compensation</label>
                <select
                  id="filter-salary"
                  className={styles.selectInput}
                  aria-label="Min compensation"
                  value={salaryMin}
                  disabled={loading || error}
                  onChange={event => { setSalaryMin(event.target.value); setPage(1); }}
                >
                  <option value="">Any compensation</option>
                  <option value="100000">$100,000+ / yr</option>
                  <option value="150000">$150,000+ / yr</option>
                  <option value="200000">$200,000+ / yr</option>
                  <option value="250000">$250,000+ / yr</option>
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filter-level" className={styles.fieldLabel}>Experience level</label>
                <select
                  id="filter-level"
                  className={styles.selectInput}
                  aria-label="Experience level"
                  value={experienceLevel}
                  disabled={loading || error}
                  onChange={event => { setExperienceLevel(event.target.value); setPage(1); }}
                >
                  <option value="">All experience levels</option>
                  <option value="intern">Intern / Student</option>
                  <option value="entry">Entry / Junior</option>
                  <option value="mid">Mid-level</option>
                  <option value="senior">Senior / Lead</option>
                  <option value="staff">Staff / Principal</option>
                  <option value="executive">Executive / Director</option>
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filter-type" className={styles.fieldLabel}>Employment type</label>
                <select
                  id="filter-type"
                  className={styles.selectInput}
                  aria-label="Employment type"
                  value={employmentType}
                  disabled={loading || error}
                  onChange={event => { setEmploymentType(event.target.value); setPage(1); }}
                >
                  <option value="">All employment types</option>
                  <option value="full-time">Full-time</option>
                  <option value="contract">Contract</option>
                  <option value="internship">Internship</option>
                  <option value="part-time">Part-time</option>
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filter-company" className={styles.fieldLabel}>Company</label>
                <select
                  id="filter-company"
                  className={styles.selectInput}
                  aria-label="Company"
                  value={company}
                  disabled={loading || error}
                  onChange={event => { setCompany(event.target.value); setPage(1); }}
                >
                  <option value="">All companies</option>
                  {companies.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filter-channel" className={styles.fieldLabel}>Application channel</label>
                <select
                  id="filter-channel"
                  className={styles.selectInput}
                  aria-label="Application channel"
                  value={channel}
                  disabled={loading || error}
                  onChange={event => { setChannel(event.target.value); setPage(1); }}
                >
                  <option value="">All channels</option>
                  {channels.map(value => <option key={value} value={value}>{value}</option>)}
                </select>
              </div>
              <div className={styles.filterField}>
                <label htmlFor="filter-sort" className={styles.fieldLabel}>Sort by</label>
                <select
                  id="filter-sort"
                  className={styles.selectInput}
                  aria-label="Sort by"
                  value={sort}
                  onChange={event => { setSort(event.target.value); setPage(1); }}
                >
                  <option value="newest">Newest first seen</option>
                  <option value="oldest">Oldest first seen</option>
                  <option value="salary-high">Highest compensation</option>
                  <option value="salary-low">Lowest compensation</option>
                  <option value="company">Company A–Z</option>
                </select>
              </div>
            </div>
          )}

          <p className={styles.filterHint}>Search covers every published listing. Combine words to narrow your results.</p>
          {!loading && !error && (
            <p className={styles.filterHint}>
              Location or workplace data for {verifiedLocationsCount} of {jobs.length} listings · Checked {locationIndex.collectedAt.slice(0, 10)}. Country / region uses the employer’s structured address, not eligibility. Remote may have geographic restrictions.
            </p>
          )}
        </section>

        {filtered && (
          <div className={styles.activeChipsBar} aria-label="Active filters">
            <span className={styles.activeChipsLabel}>Active:</span>
            <div className={styles.activeChipsList}>
              {query && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setQuery(""); setPage(1); }}
                  aria-label={`Remove search filter ${query}`}
                >
                  Search: <strong>&ldquo;{query}&rdquo;</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              {location && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setLocation(""); setPage(1); }}
                  aria-label={`Remove location filter ${location}`}
                >
                  Location: <strong>&ldquo;{location}&rdquo;</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              {country && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setCountry(""); setPage(1); }}
                  aria-label={`Remove country filter ${countryLabel(country)}`}
                >
                  Country: <strong>{countryLabel(country)}</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              {workplace && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setWorkplace(""); setPage(1); }}
                  aria-label={`Remove arrangement filter ${workplace}`}
                >
                  Workplace: <strong>{workplace === "onsite" ? "On-site" : workplace === "unknown" ? "Not specified" : workplace.charAt(0).toUpperCase() + workplace.slice(1)}</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              {salaryMin && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setSalaryMin(""); setPage(1); }}
                  aria-label={`Remove salary filter $${Number(salaryMin)/1000}k+`}
                >
                  Salary: <strong>${Number(salaryMin)/1000}k+/yr</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              {experienceLevel && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setExperienceLevel(""); setPage(1); }}
                  aria-label={`Remove experience level filter ${experienceLevel}`}
                >
                  Level: <strong>{experienceLevel.charAt(0).toUpperCase() + experienceLevel.slice(1)}</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              {employmentType && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setEmploymentType(""); setPage(1); }}
                  aria-label={`Remove employment type filter ${employmentType}`}
                >
                  Type: <strong>{employmentType.charAt(0).toUpperCase() + employmentType.slice(1)}</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              {company && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setCompany(""); setPage(1); }}
                  aria-label={`Remove company filter ${company}`}
                >
                  Company: <strong>{company}</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              {channel && (
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => { setChannel(""); setPage(1); }}
                  aria-label={`Remove channel filter ${channel}`}
                >
                  Channel: <strong>{channel}</strong> <span className={styles.chipIcon} aria-hidden="true">×</span>
                </button>
              )}
              <button type="button" className={styles.clearAllBtn} onClick={clear}>
                Clear all filters
              </button>
            </div>
          </div>
        )}


        <div ref={summaryRef} tabIndex={-1} className={styles.summaryBar} role="status" aria-live="polite">
          <span className={styles.summaryCounts}>
            {loading ? "Loading published jobs…" : error ? "Search unavailable" : `${results.length} ${results.length === 1 ? "job" : "jobs"}${filtered ? ` matching · ${jobs.length} total` : " available"}`}
          </span>
          {!loading && !error && results.length > 0 && (
            <span className={styles.summaryPages}>
              Page {pagination.page} of {pagination.totalPages}
            </span>
          )}
        </div>

        {loading && (
          <div className={styles.skeletonList} aria-hidden="true">
            {[1, 2, 3].map((n) => (
              <div key={n} className={styles.skeletonCard}>
                <div className={styles.skeletonHeader}>
                  <div className={styles.skeletonAvatar} />
                  <div className={styles.skeletonMeta}>
                    <div className={styles.skeletonCompany} />
                    <div className={styles.skeletonHost} />
                  </div>
                </div>
                <div className={styles.skeletonTitle} />
                <div className={styles.skeletonBadges}>
                  <div className={styles.skeletonBadge} />
                  <div className={styles.skeletonBadge} />
                </div>
                <div className={styles.skeletonFooter}>
                  <div className={styles.skeletonEvidence} />
                  <div className={styles.skeletonBtn} />
                </div>
              </div>
            ))}
          </div>
        )}

        {error && (
          <div className={styles.notice} role="alert">
            <h2>Search unavailable</h2>
            <p>We couldn’t load the complete directory. Retry to search all published jobs.</p>
            <button type="button" className="button button-secondary" onClick={retry}>Retry</button>
          </div>
        )}

        {!loading && !error && results.length === 0 && (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
            </div>
            <h2>{filtered ? "No matching jobs" : "No published jobs yet"}</h2>
            <p>
              {filtered
                ? "Try fewer words or clear a filter. Listings without verified location data won’t match location or country filters."
                : "Check back later for new opportunities."}
            </p>
            {filtered && (
              <div className={styles.emptyActions}>
                <button type="button" className="button button-secondary" onClick={clear}>Clear filters</button>
              </div>
            )}
          </div>
        )}

        {results.length > 0 && (
          <ul className={styles.list} aria-label="Published job listings">
            {results.slice(pagination.start, pagination.end).map(job => {
              const workplaceInfo = getWorkplaceMeta(job.location?.workplace);
              const hostname = getHostname(job.url);
              const firstInitial = job.company.trim().charAt(0).toUpperCase() || "●";
              const avatarStyle = getAvatarStyle(job.company);
              const salary = job.location?.salary || estimateBenchmarkSalary(job.role, job.location?.countries?.[0]);
              const jobEmployment = job.location?.employmentType || extractEmploymentType(job.role);
              const jobExperience = job.location?.experienceLevel || extractExperienceLevel(job.role);

              return (
                <li key={job.jobId} className={styles.jobCard}>
                  <div className={styles.cardHeader}>
                    <div className={styles.companyLockup}>
                      <div
                        className={styles.companyAvatar}
                        style={{ backgroundColor: avatarStyle.bg, color: avatarStyle.color, borderColor: avatarStyle.border }}
                        aria-hidden="true"
                      >
                        {firstInitial}
                      </div>
                      <div className={styles.companyMeta}>
                        <span className={styles.companyName}>{job.company}</span>
                        <span className={styles.hostname}>{hostname}</span>
                      </div>
                    </div>
                    <time dateTime={job.firstSeenAt} className={styles.seenDate} title={`First seen on ${job.firstSeenAt.slice(0, 10)}`}>
                      {formatRelativeDate(job.firstSeenAt)}
                    </time>
                  </div>

                  <div className={styles.cardBody}>
                    <h2 className={styles.jobTitle}>
                      <a href={job.url} target="_blank" rel="noopener noreferrer">
                        {job.role}
                        <span aria-hidden="true"> ↗</span>
                        <span className={styles.srOnly}> (opens in a new tab)</span>
                      </a>
                    </h2>

                    <div className={styles.badgeGroup}>
                      {workplaceInfo && (
                        <span className={`${styles.badge} ${workplaceInfo.className}`}>
                          <span aria-hidden="true">{workplaceInfo.icon} </span>
                          {workplaceInfo.label}
                        </span>
                      )}
                      {salary && (
                        <span
                          className={`${styles.badge} ${salary.isEstimated ? styles.badgeSalaryEstimated : styles.badgeSalaryVerified}`}
                          title={salary.isEstimated ? "Estimated market range based on role, level, and location benchmarks" : "Verified salary stated by employer in posting"}
                        >
                          <span aria-hidden="true">{salary.isEstimated ? "~" : "$"} </span>
                          {salary.label}
                        </span>
                      )}
                      {jobExperience === "staff" && (
                        <span className={`${styles.badge} ${styles.badgeStaff}`}>
                          Staff / Principal
                        </span>
                      )}
                      {jobExperience === "executive" && (
                        <span className={`${styles.badge} ${styles.badgeStaff}`}>
                          Executive / Lead
                        </span>
                      )}
                      {jobEmployment === "internship" && (
                        <span className={`${styles.badge} ${styles.badgeInternship}`}>
                          Internship
                        </span>
                      )}
                      {jobEmployment === "contract" && (
                        <span className={`${styles.badge} ${styles.badgeContract}`}>
                          Contract
                        </span>
                      )}
                      {job.location?.label && (
                        <span className={styles.locationTag} title={job.location.label}>
                          <svg className={styles.pinIcon} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path d="M8 1a5 5 0 0 0-5 5c0 3.5 5 9 5 9s5-5.5 5-9a5 5 0 0 0-5-5zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4z" />
                          </svg>
                          {job.location.label}
                        </span>
                      )}
                      <span className={styles.channelTag}>
                        {job.applicationChannel}
                      </span>
                    </div>
                  </div>

                  <div className={styles.cardFooter}>
                    <div className={styles.evidenceText}>
                      {job.location ? (
                        <>Location checked <time dateTime={job.location.checkedAt}>{job.location.checkedAt.slice(0, 10)}</time></>
                      ) : (
                        <span>Direct ATS listing</span>
                      )}
                    </div>

                    <div className={styles.cardActions}>
                      <button
                        type="button"
                        className={styles.copyBtn}
                        onClick={() => copyJobLink(job)}
                        aria-label={`Copy link for ${job.role} at ${job.company}`}
                      >
                        {copiedJobId === job.jobId ? (
                          <>
                            <svg className={styles.btnIcon} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                              <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z"/>
                            </svg>
                            <span>Copied!</span>
                          </>
                        ) : (
                          <>
                            <svg className={styles.btnIcon} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                              <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
                              <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
                            </svg>
                            <span>Copy link</span>
                          </>
                        )}
                      </button>
                      <a
                        href={job.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={styles.applyBtn}
                      >
                        <span>Open posting</span>
                        <span aria-hidden="true">↗</span>
                      </a>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {!loading && !error && results.length > 0 && (
          <div className={styles.actions}>
            <p>Showing {pagination.start + 1}–{pagination.end} of {results.length} results</p>
            {pagination.totalPages > 1 && (
              <nav className={styles.pagination} aria-label="Job results pages">
                <button
                  type="button"
                  disabled={pagination.page === 1}
                  onClick={() => changePage(pagination.page - 1)}
                  aria-label="Previous page"
                >
                  Previous
                </button>
                {pagination.numbers.map((number, idx) => typeof number === "number" ? (
                  <button
                    key={number}
                    type="button"
                    aria-label={`Page ${number}`}
                    aria-current={number === pagination.page ? "page" : undefined}
                    onClick={() => changePage(number)}
                  >
                    {number}
                  </button>
                ) : (
                  <span key={`gap-${idx}`} className={styles.pageGap} aria-hidden="true">…</span>
                ))}
                <button
                  type="button"
                  disabled={pagination.page === pagination.totalPages}
                  onClick={() => changePage(pagination.page + 1)}
                  aria-label="Next page"
                >
                  Next
                </button>
              </nav>
            )}
          </div>
        )}

        <section id="methodology" className={styles.methodology} aria-labelledby="vetting-heading">
          <div>
            <p className="eyebrow">Vetting & Integrity</p>
            <h2 id="vetting-heading">How published jobs are reviewed.</h2>
          </div>
          <div className={styles.methodologyContent}>
            <p>
              <strong>Direct ATS destinations:</strong> Every listing is resolved to its canonical employer or applicant tracking system page (Greenhouse, Ashby, Lever, Workable, direct careers). Third-party recruiter redirects and ghost aggregators are rejected.
            </p>
            <p>
              <strong>Active status:</strong> Roles are confirmed accessible and accepting applications at the time of review. Expired requisitions and closed pages are withheld.
            </p>
            <p>
              <strong>Identity-free:</strong> Sourced anonymously from active Job Application Agent installations. Personal profiles, candidate identities, resumes, and scores are never transmitted or stored.
            </p>
          </div>
        </section>

        <footer className={styles.unlistedNotice}>
          Accessible by direct link. This page is unlisted, not private.
        </footer>
      </main>
      <SiteFooter community />
    </div>
  );
}

