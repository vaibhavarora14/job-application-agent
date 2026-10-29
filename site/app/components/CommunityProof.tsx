"use client";

import { compactNumber, hasLifetimeCounters, useCommunityStats } from "./useCommunityStats";

const metrics = [
  ["installations", "Total installations"],
  ["applicationsSubmitted", "Verified applications submitted"],
  ["jobsAssessed", "Jobs assessed"],
] as const;

/** Lifetime community totals. Renders nothing until every counter is a real number (no placeholders). */
export function CommunityProof({ className }: { className?: string }) {
  const { data } = useCommunityStats();
  if (!hasLifetimeCounters(data)) return null;
  return <section className={className} aria-label="Community momentum">
    <div className="community-proof">
      <div className="proof-heading">
        <div><p className="eyebrow">Community momentum</p><h2 id="community-proof-title">Real work, counted honestly.</h2></div>
        <a className="text-link" href="https://stats.jobappagent.com">Explore community stats <span aria-hidden="true">→</span></a>
      </div>
      <div className="metric-grid">
        {metrics.map(([key, label]) => <article className="metric-card" key={key}>
          <strong>{compactNumber.format(data.metrics[key])}</strong>
          <span>{label}</span>
        </article>)}
      </div>
      <p className="data-note" role="status">{`Anonymous aggregate telemetry · Updated ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.generatedAt))}`}</p>
    </div>
  </section>;
}
