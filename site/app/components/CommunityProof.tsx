"use client";

import { compactNumber, useCommunityStats } from "./useCommunityStats";

const metrics = [
  ["installations", "Total installations"],
  ["applicationsSubmitted", "Verified applications submitted"],
  ["jobsAssessed", "Jobs assessed"],
] as const;

export function CommunityProof() {
  const { data, error, loading } = useCommunityStats();
  return <section className="community-proof" aria-labelledby="community-proof-title">
    <div className="proof-heading">
      <div><p className="eyebrow">Community momentum</p><h2 id="community-proof-title">Real work, counted honestly.</h2></div>
      <a className="text-link" href="https://stats.jobappagent.com">Explore community stats <span aria-hidden="true">→</span></a>
    </div>
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
    <p className={`data-note${error ? " data-note-error" : ""}`} role="status">
      {error
        ? "Live aggregate data is resting. Evidence will return here when the feed is available — we do not invent placeholder counts."
        : data
          ? `Anonymous aggregate telemetry · Updated ${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(data.generatedAt))}`
          : "Loading anonymous aggregate telemetry…"}
    </p>
  </section>;
}
