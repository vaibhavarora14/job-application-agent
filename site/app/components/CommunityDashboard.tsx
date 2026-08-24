"use client";

import { compactNumber, fullNumber, useCommunityStats } from "./useCommunityStats";
import { useCommunityJobs } from "./useCommunityJobs";

function Leaderboard({ title, subtitle, entries, wide = false }: { title: string; subtitle: string; entries: Array<{ label: string; count: number }>; wide?: boolean }) {
  const maximum = Math.max(1, ...entries.map((entry) => entry.count));
  return <article className={`dashboard-panel${wide ? " dashboard-panel-wide" : ""}`}>
    <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><span className="tag">Aggregate</span></div>
    <div className="leaderboard">{entries.length ? entries.slice(0, 7).map((entry) => <div className="leaderboard-row" key={entry.label}>
      <span className="leaderboard-label">{entry.label.replaceAll("-", " ")}</span>
      <progress className="leaderboard-track" max={maximum} value={entry.count} aria-label={`${entry.label}: ${entry.count}`} />
      <strong>{fullNumber.format(entry.count)}</strong>
    </div>) : <p className="empty-data">Waiting for enough privacy-safe data.</p>}</div>
  </article>;
}

export function CommunityDashboard() {
  const { data, error, loading } = useCommunityStats();
  const communityJobs = useCommunityJobs();
  const outcomesReported = data?.breakdowns.outcomes.reduce((total, entry) => total + entry.count, 0) ?? 0;
  const outcomeCoverage = data?.metrics.applicationsSubmitted
    ? Math.round((outcomesReported / data.metrics.applicationsSubmitted) * 1000) / 10
    : 0;
  const recentDays = data?.timeline.slice(-7) ?? [];
  const maximum = Math.max(1, ...recentDays.map((day) => day.submitted));

  return <main id="main" className="dashboard page-width">
    <section className="dashboard-hero">
      <div><p className="eyebrow">Community momentum</p><h1>The job search is moving.</h1><p>Anonymous, verified activity from Job Application Agent installations. No names, profiles, résumés, or raw identifiers.</p></div>
      <div className={`live-status${error ? " live-status-error" : ""}`} role="status"><span />{error ? "Live feed unavailable" : loading ? "Connecting to live aggregate data" : "Live anonymous community data"}</div>
    </section>

    <section className="dashboard-metrics" aria-label="Community totals" aria-busy={loading}>
      <article><strong>{data ? compactNumber.format(data.metrics.activeInstallations30d) : "—"}</strong><span>Active installations · last 30 days</span></article>
      <article><strong>{data ? compactNumber.format(data.metrics.applicationsSubmitted) : "—"}</strong><span>Verified applications submitted</span></article>
      <article><strong>{data ? compactNumber.format(data.metrics.jobsAssessed) : "—"}</strong><span>Jobs assessed</span></article>
    </section>

    <section className="community-jobs dashboard-panel" aria-labelledby="community-jobs-title" aria-busy={communityJobs.loading || communityJobs.loadingMore}>
      <div className="panel-heading">
        <div><p className="eyebrow">Community sourcing</p><h2 id="community-jobs-title">Community job leads</h2><p>Confirmed public application links reported by agent installations and published only after maintainer review.</p></div>
        <span className="tag">Maintainer-reviewed</span>
      </div>
      <p className="community-jobs-caution"><strong>Verify every lead.</strong> Community reports are not employer endorsements; check the company, role, and destination before applying.</p>
      {communityJobs.loading ? <p className="empty-data" role="status">Loading reviewed job leads…</p>
        : communityJobs.error && communityJobs.jobs.length === 0 ? <p className="empty-data" role="status">Reviewed job leads are temporarily unavailable.</p>
          : communityJobs.jobs.length === 0 ? <p className="empty-data">No job leads have completed maintainer review yet.</p>
            : <ol className="community-job-list">{communityJobs.jobs.map((job) => <li key={job.jobId}>
              <div className="community-job-copy"><span>{job.company}</span><h3>{job.role}</h3><p>{job.applicationChannel.replaceAll("-", " ")} · {fullNumber.format(job.contributionCount)} agent {job.contributionCount === 1 ? "report" : "reports"}</p></div>
              <div className="community-job-actions"><a className="button button-small" href={job.url} target="_blank" rel="noopener noreferrer">Open job</a><a className="text-link" href={job.providerUrl} target="_blank" rel="noopener noreferrer">Provider ↗</a></div>
            </li>)}</ol>}
      {communityJobs.nextCursor ? <button className="button button-secondary community-jobs-more" type="button" disabled={communityJobs.loadingMore} onClick={() => void communityJobs.loadMore()}>{communityJobs.loadingMore ? "Loading…" : "Load more reviewed jobs"}</button> : null}
    </section>

    <section className="dashboard-grid">
      <article className="dashboard-panel activity-panel">
        <div className="panel-heading"><div><h2>Reported activity by day</h2><p>Verified application success states across recent reporting days</p></div><span className="tag">Includes backfill</span></div>
        <div className="activity-chart" role="img" aria-label="Verified applications by recent reporting day">
          {recentDays.length ? recentDays.map((day) => <div className="activity-column" key={day.day} title={`${day.day}: ${day.submitted} verified applications`}>
            <strong>{fullNumber.format(day.submitted)}</strong><progress className="activity-bar" max={maximum} value={day.submitted} aria-label={`${day.day}: ${day.submitted} verified applications`} /><small>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day.day}T00:00:00Z`))}</small>
          </div>) : <p className="empty-data">Waiting for verified activity.</p>}
        </div>
        <p className="backfill-note"><strong>Read the trend carefully.</strong> Totals include clearly labelled historical backfill, so individual spikes are not presented as organic daily growth.</p>
      </article>
      <article className="dashboard-panel outcome-panel">
        <div className="panel-heading"><div><h2>Outcome coverage</h2><p>Early signal, not a placement claim</p></div><span className="tag">{outcomeCoverage}% reported</span></div>
        <strong className="outcome-number">{fullNumber.format(outcomesReported)}</strong>
        <p>known outcomes from {data ? fullNumber.format(data.metrics.applicationsSubmitted) : "—"} verified applications.</p>
        <div className="outcome-list">{data?.breakdowns.outcomes.map((entry) => <span key={entry.label}><i />{fullNumber.format(entry.count)} {entry.label}</span>)}</div>
      </article>
      <Leaderboard title="Where applications land" subtitle="Verified submissions by ATS · last 90 days" entries={data?.breakdowns.ats ?? []} />
      <Leaderboard title="Role levels in view" subtitle="Privacy-safe seniority segments · last 90 days" entries={data?.breakdowns.seniority ?? []} wide />
    </section>

    <section id="methodology" className="methodology">
      <div><p className="eyebrow">Methodology</p><h2>Proof without profiles.</h2></div>
      <div><p><strong>Active installation</strong> means an anonymous installation assessed a job or submitted an application during the last 30 days. It is not a verified individual-person count.</p><p><strong>Verified application</strong> means the employer or ATS showed a confirmed submission success state.</p><p>Segments with fewer than {data?.privacy.minimumSegmentCount ?? 3} observations are grouped into “other.”</p></div>
    </section>
    <p className="dashboard-updated">{data ? `Updated ${new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }).format(new Date(data.generatedAt))}` : "Anonymous aggregate telemetry"}</p>
  </main>;
}
