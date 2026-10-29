"use client";

import { publicOutcomeEntries } from "../../lib/community-stats.mjs";
import { compactNumber, fullNumber, hasLifetimeCounters, useCommunityStats } from "./useCommunityStats";

function Leaderboard({ title, subtitle, entries }: { title: string; subtitle: string; entries: Array<{ label: string; count: number }> }) {
  const maximum = Math.max(1, ...entries.map((entry) => entry.count));
  return <article className="dashboard-panel">
    <div className="panel-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><span className="tag">Aggregate</span></div>
    <div className="leaderboard">{entries.slice(0, 7).map((entry) => <div className="leaderboard-row" key={entry.label}>
      <span className="leaderboard-label">{entry.label.replaceAll("-", " ")}</span>
      <progress className="leaderboard-track" max={maximum} value={entry.count} aria-label={`${entry.label}: ${entry.count}`} />
      <strong>{fullNumber.format(entry.count)}</strong>
    </div>)}</div>
  </article>;
}

export function CommunityDashboard() {
  const { data, error, loading } = useCommunityStats();
  const counted = hasLifetimeCounters(data);
  const outcomesReported = data?.breakdowns.outcomes.reduce((total, entry) => total + entry.count, 0) ?? 0;
  const outcomeCoverage = data?.metrics.applicationsSubmitted
    ? Math.round((outcomesReported / data.metrics.applicationsSubmitted) * 1000) / 10
    : 0;
  const recentDays = data?.timeline.slice(-7) ?? [];
  const maximum = Math.max(1, ...recentDays.map((day) => day.submitted));
  const ats = data?.breakdowns.ats ?? [];
  const seniority = data?.breakdowns.seniority ?? [];
  // Need-only: every section and card renders only when it has real data. With nothing to
  // show, the page carries a single waiting line (after loading), never empty headings or cards.
  const showActivity = recentDays.length > 0;
  const showExecution = showActivity || counted;
  const showCoverage = ats.length > 0 || seniority.length > 0;
  const nothingToShow = !counted && !showExecution && !showCoverage;

  return <main id="main" className="dashboard page-width">
    <section className="dashboard-hero">
      <div><p className="eyebrow">Aggregate product evidence</p><h1>See the work the agent is doing.</h1><p>Verified, anonymous activity from Job Application Agent installations. This page shows adoption, execution, and reported outcomes, not job listings or individual profiles.</p></div>
      <div className="dashboard-hero-meta">
        {error ? null : <div className="live-status" role="status"><span />{loading ? "Connecting to live aggregate data" : "Live anonymous community data"}</div>}
        <a className="dashboard-method-link" href="#methodology">How this evidence works ↓</a>
      </div>
    </section>

    {counted ? <section className="dashboard-evidence" aria-labelledby="evidence-heading">
      <div className="dashboard-section-heading">
        <div><p className="eyebrow">Evidence at a glance</p><h2 id="evidence-heading">Current adoption and verified execution.</h2></div>
        <p>Installations are lifetime cumulative totals. Assessed jobs show research volume. Submitted applications require a confirmed employer or ATS success state.</p>
      </div>
      <div className="dashboard-metrics" aria-label="Community totals">
        <article><strong>{compactNumber.format(data.metrics.installations)}</strong><span>Total installations</span></article>
        <article><strong>{compactNumber.format(data.metrics.applicationsSubmitted)}</strong><span>Verified applications submitted</span></article>
        <article><strong>{compactNumber.format(data.metrics.jobsAssessed)}</strong><span>Jobs assessed</span></article>
      </div>
    </section> : null}

    {nothingToShow && !loading ? <p className="empty-data dashboard-waiting" role="status">Waiting for verified activity.</p> : null}

    {showExecution ? <section className="dashboard-section" aria-labelledby="execution-heading">
      <div className="dashboard-section-heading">
        <div><p className="eyebrow">Execution signal</p><h2 id="execution-heading">Activity over time, with outcomes kept in context.</h2></div>
        <p>Trends show verified submissions by reporting day. Outcome coverage shows how much of that work has a reported result; it is not a placement rate.</p>
      </div>
      <div className={`dashboard-grid dashboard-grid-execution${showActivity && counted ? "" : " dashboard-grid-single"}`}>
        {showActivity ? <article className="dashboard-panel activity-panel">
          <div className="panel-heading"><div><h3>Verified submissions by day</h3><p>Recent reporting days; historical backfill is labelled below</p></div><span className="tag">Includes backfill</span></div>
          <div className="activity-chart" role="img" aria-label="Verified applications by recent reporting day">
            {recentDays.map((day) => <div className="activity-column" key={day.day} title={`${day.day}: ${day.submitted} verified applications`}>
              <strong>{fullNumber.format(day.submitted)}</strong><progress className="activity-bar" max={maximum} value={day.submitted} aria-label={`${day.day}: ${day.submitted} verified applications`} /><small>{new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day.day}T00:00:00Z`))}</small>
            </div>)}
          </div>
          <p className="backfill-note"><strong>Read the trend carefully.</strong> Totals include clearly labelled historical backfill, so individual spikes are not presented as organic daily growth.</p>
        </article> : null}
        {/* Outcome card renders only with real counters (rate + "of N" sentence); otherwise hidden. Page-level fallback: "Waiting for verified activity." */}
        {counted ? <article className="dashboard-panel outcome-panel">
          <div className="panel-heading"><div><h3>Outcome coverage</h3><p>Early signal, not a placement claim</p></div></div>
          <strong className="outcome-number">{`${outcomeCoverage}%`}</strong>
          <p>of {fullNumber.format(data.metrics.applicationsSubmitted)} verified applications have a reported outcome</p>
          <div className="outcome-list">{publicOutcomeEntries(data?.breakdowns.outcomes ?? []).map((entry) => <span key={entry.label}><i />{fullNumber.format(entry.count)} {entry.label}</span>)}</div>
        </article> : null}
      </div>
    </section> : null}

    {showCoverage ? <section className="dashboard-section" aria-labelledby="coverage-heading">
      <div className="dashboard-section-heading">
        <div><p className="eyebrow">Application coverage</p><h2 id="coverage-heading">Where the work is concentrated.</h2></div>
        <p>ATS segments describe verified submission destinations. Seniority segments describe discovered roles. Small segments stay grouped to preserve privacy.</p>
      </div>
      <div className={`dashboard-grid dashboard-grid-coverage${ats.length && seniority.length ? "" : " dashboard-grid-single"}`}>
        {ats.length ? <Leaderboard title="Application destinations" subtitle="Verified submissions by ATS · last 90 days" entries={ats} /> : null}
        {seniority.length ? <Leaderboard title="Role levels discovered" subtitle="Privacy-safe seniority segments · last 90 days" entries={seniority} /> : null}
      </div>
    </section> : null}

    <section id="methodology" className="methodology">
      <div><p className="eyebrow">Methodology</p><h2>How the evidence is counted.</h2></div>
      <div><p><strong>Total installations</strong> means the lifetime count of anonymous installations that have contributed aggregate telemetry. It is not a verified individual-person count.</p><p><strong>Verified application</strong> means the employer or ATS showed a confirmed submission success state.</p><p>Segments with fewer than {data?.privacy.minimumSegmentCount ?? 3} observations are grouped into “other.”</p></div>
    </section>
    <p className="dashboard-updated">{data ? `Updated ${new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }).format(new Date(data.generatedAt))}` : "Anonymous aggregate telemetry"}</p>
  </main>;
}
