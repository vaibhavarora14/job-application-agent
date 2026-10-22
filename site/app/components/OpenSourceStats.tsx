"use client";

import { compactNumber, useCommunityStats } from "./useCommunityStats";

/** Only these three aggregate counts are shown. Never offers or interview figures. */
const metrics = [
  ["installations", "Installations"],
  ["jobsAssessed", "Jobs assessed"],
  ["applicationsSubmitted", "Confirmed applications"],
] as const;

export function OpenSourceStats({ className }: { className?: string }) {
  const { data, loading } = useCommunityStats();
  return <section className={className} aria-label="Live community stats">
    <div className="metric-grid" aria-busy={loading}>
      {metrics.map(([key, label]) => <article className="metric-card" key={key}>
        <strong>
          {data
            ? compactNumber.format(data.metrics[key])
            : loading
              ? <span className="metric-pending">Loading</span>
              : <span className="metric-empty">—</span>}
        </strong>
        <span>{label}</span>
      </article>)}
    </div>
    <p className="data-note">Anonymous, aggregate counts from installs that leave analytics on.</p>
  </section>;
}
