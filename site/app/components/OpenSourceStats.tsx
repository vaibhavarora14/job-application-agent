"use client";

import { compactNumber, hasLifetimeCounters, useCommunityStats } from "./useCommunityStats";

/** Only these three aggregate counts are shown. Never offers or interview figures. */
const metrics = [
  ["installations", "Installations"],
  ["jobsAssessed", "Jobs assessed"],
  ["applicationsSubmitted", "Confirmed applications"],
] as const;

/** Renders nothing until every lifetime counter is a real number (no placeholders). */
export function OpenSourceStats({ className }: { className?: string }) {
  const { data } = useCommunityStats();
  if (!hasLifetimeCounters(data)) return null;
  return <section className={className} aria-label="Live community stats">
    <div className="metric-grid">
      {metrics.map(([key, label]) => <article className="metric-card" key={key}>
        <strong>{compactNumber.format(data.metrics[key])}</strong>
        <span>{label}</span>
      </article>)}
    </div>
    <p className="data-note">Anonymous, aggregate counts from installs that leave analytics on.</p>
  </section>;
}
