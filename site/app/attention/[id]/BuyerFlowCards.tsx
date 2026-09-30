import type { ReactNode } from "react";
import { DESIGN_JOBS } from "../../../lib/attention-design-fixtures.mjs";

export function FlowCard({ title, body, icon = "check", children }: {
  title: string; body: string; icon?: "check" | "queue" | "ready" | "alert"; children?: ReactNode;
}) {
  const paths = {
    check: "M20 6 9 17l-5-5",
    queue: "M5 7h14M5 12h10M5 17h7",
    ready: "M9 11.5 11.2 13.7 15.6 8.8M5.5 4.5h13v15h-13z",
    alert: "M12 9v4M12 17h.01M10.3 4.3 2.8 17.5a2 2 0 0 0 1.7 3h15a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z",
  };
  return <section className="buyer-card buyer-card-centered">
    <span className="buyer-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[icon]} /></svg></span>
    <h2>{title}</h2><p>{body}</p>{children}
  </section>;
}

export function PreflightCard() {
  return <FlowCard title="Preflight complete" body="The apply queue begins only after the essentials are ready." icon="ready">
    <div className="buyer-rows">{["Resume ready", "Profile ready"].map((label) => <div className="buyer-row" key={label}>
      <span><span className="buyer-ready-check" aria-hidden="true">✓</span>{label}</span><span>Set</span>
    </div>)}</div>
  </FlowCard>;
}

export function ChooseCard({ selected, toggle }: { selected: string[]; toggle: (id: string) => void }) {
  return <section className="buyer-card buyer-jobs" aria-label="Choose jobs">
    <p className="buyer-help">Toggle cards to shape this queue. The primary action reflects the selected count.</p>
    {DESIGN_JOBS.map((job) => <button type="button" className="buyer-job" key={job.id} aria-pressed={selected.includes(job.id)} onClick={() => toggle(job.id)}>
      <span className="buyer-job-toggle" aria-hidden="true">{selected.includes(job.id) ? "✓" : ""}</span>
      <span><strong>{job.role}</strong><small>{job.company} · {job.detail}</small></span>
    </button>)}
  </section>;
}

export function QueueCard({ count, expanded, role, company, selected }: {
  count: number; expanded: boolean; role: string; company: string; selected?: string[];
}) {
  return <>
    <FlowCard title="Applying in your queue" body="Calm progress. We’ll pause only if a question needs your answer." icon="queue">
      <div className="buyer-rows">
        <div className="buyer-row"><span>In progress</span><span>{count}</span></div>
        <div className="buyer-row"><span>Waiting on you</span><span>0</span></div>
      </div>
    </FlowCard>
    {expanded && <section className="buyer-card buyer-queue-list" tabIndex={-1} id="buyer-queue-list" aria-label="Jobs in progress">
      {(selected ? DESIGN_JOBS.filter((job) => selected.includes(job.id)) : [{ id: "current", role, company }]).map((job) => <div key={job.id}>
        <strong>{job.role}</strong><p>{job.company}</p><span className="buyer-pill">In progress</span>
      </div>)}
    </section>}
  </>;
}

/** Synthetic ops contrast only; never rendered for a magic-link buyer. */
export function AdminPreviewCard() {
  return <FlowCard title="Unsolvable without live help" body={'CAPTCHA / live session issue. Buyer sees only "in progress" in their queue.'} icon="alert">
    <dl className="buyer-admin-meta">
      <div><dt>Role</dt><dd>Forward Deployed Engineer</dd></div>
      <div><dt>Company</dt><dd>Acme Robotics</dd></div>
      <div><dt>Reason</dt><dd>Employer CAPTCHA — not auto-solvable</dd></div>
    </dl>
  </FlowCard>;
}
