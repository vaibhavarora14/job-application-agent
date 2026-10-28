import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import {
  channelLabel,
  employerPostedAt,
  formatClosedDate,
  formatReviewedDate,
  locationLabel,
  payRows,
} from "../../lib/live-jobs.mjs";
import { workplaceLabel } from "../../lib/jobs-board-query.mjs";
import { buildApplyAgentPrompt, buildApplyCliCommand } from "../../lib/job-apply-copy.mjs";
import { CopyButton } from "./CopyButton";
import { JobRow } from "./JobRow";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import styles from "./jobs.module.css";
import type { BoardJob } from "./JobsBoard";

const AGENTS_HINT = "For Cursor, Claude Code or Codex. You approve before anything is sent.";

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.btnIcon}>
      <path d="M12.5 4.5L7 10l5.5 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.btnIcon}>
      <path d="M7 13l6.5-6.5M8 6.5h5.5V12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={styles.btnIcon}>
      <rect x="7" y="7" width="9" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.7" />
      <path d="M13 4.5H6A1.5 1.5 0 0 0 4.5 6v7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={`${styles.btnIcon} ${styles.chev}`}>
      <path d="M5.5 8l4.5 4.5L14.5 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function employmentLabel(value: string | null | undefined) {
  if (!value) return "";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Open posting on Ashby"; generic when the source is not a named ATS. */
function postingLabel(job: BoardJob, verb: "Open posting" | "Read the full posting") {
  const ats = channelLabel(job.applicationChannel);
  return ats ? `${verb} on ${ats}` : verb;
}

function PayValue({ job }: { job: BoardJob }) {
  const pay = payRows(job);
  if (!pay) return null;
  if (pay.single) return <>{pay.single}</>;
  return (
    <span className={styles.payBands}>
      {pay.bands.map((band, index) => (
        <span key={`${index}-${band.name ?? ""}-${band.range}`} className={styles.payBand}>
          {band.name ? <span className={styles.payBandName}>{`${band.name}:`}</span> : null}
          {band.name ? " " : null}
          <span className={styles.payBandRange}>{band.range}</span>
        </span>
      ))}
      {pay.more > 0 ? (
        <a className={styles.payBandMore} href={job.url} rel="nofollow noopener noreferrer" target="_blank">
          {`+${pay.more} more ${pay.more === 1 ? "band" : "bands"}`}
        </a>
      ) : null}
    </span>
  );
}

/** Employer-stated facts only. Unknown facts (pay included) are left out and the grid closes up. */
function Facts({ job }: { job: BoardJob }) {
  const pay = payRows(job);
  const multiBand = Boolean(pay && !pay.single);
  const cells: { key: string; label: string; value: ReactNode; wide?: boolean }[] = [];
  if (pay) cells.push({ key: "pay", label: "Pay", value: <PayValue job={job} />, wide: multiBand });
  const workplace = workplaceLabel(job);
  if (workplace) cells.push({ key: "workplace", label: "Workplace", value: workplace });
  const place = locationLabel(job);
  // A long place list gets its own row instead of a tall narrow cell.
  if (place && place !== workplace) cells.push({ key: "location", label: "Location", value: place, wide: place.length > 48 });
  const type = employmentLabel(job.location?.employmentType);
  if (type) cells.push({ key: "type", label: "Type", value: type });
  if (cells.length === 0) return null;
  const narrow = cells.filter((cell) => !cell.wide);
  // Two columns on phones: an odd last cell spans the row so no empty slot shows.
  const fill = narrow.length % 2 === 1 ? narrow[narrow.length - 1].key : null;
  return (
    <dl className={styles.facts} style={{ "--cols": Math.max(1, narrow.length) } as CSSProperties}>
      {cells.map((cell) => (
        <div
          key={cell.key}
          className={[
            cell.key === "pay" ? styles.factPay : "",
            cell.wide ? styles.factWide : "",
            cell.key === fill ? styles.factFill : "",
          ].filter(Boolean).join(" ") || undefined}
        >
          <dt>{cell.label}</dt>
          <dd>{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ApplyCard({ job }: { job: BoardJob }) {
  const prompt = buildApplyAgentPrompt(job);
  const cli = buildApplyCliCommand(job.url);
  return (
    <div className={styles.railCard}>
      <h2 className={styles.railTitle}>Apply with your agent</h2>
      <h2 className={styles.howTitle}>How applying works</h2>
      <p className={styles.railLead}>
        Copy a prompt for Cursor, Claude Code or Codex. Your agent fills the application on {job.company}&apos;s
        posting and stops for your approval before anything is sent.
      </p>
      <div className={styles.railActions}>
        <CopyButton
          value={prompt}
          label="Copy prompt"
          copiedLabel="Copied"
          icon={<CopyIcon />}
          className={`${styles.btn} ${styles.pri} ${styles.full}`}
          copiedNote="Copied. Paste it into your agent."
          noteClassName={styles.copiedNote}
        />
        <a className={`${styles.btn} ${styles.btn2} ${styles.full}`} href={job.url} target="_blank" rel="noopener noreferrer">
          {postingLabel(job, "Open posting")}
          <ExternalIcon />
        </a>
      </div>
      <details className={styles.pv}>
        <summary>
          Preview the prompt
          <ChevronIcon />
        </summary>
        <pre>{prompt}</pre>
      </details>
      <div className={styles.rule} />
      <p className={styles.lab}>Prefer the terminal?</p>
      <div className={styles.cmd}>
        <code>{cli}</code>
        <CopyButton value={cli} ariaLabel="Copy command" icon={<CopyIcon />} className={styles.iconBtn} />
      </div>
    </div>
  );
}

function ApplyBar({ job }: { job: BoardJob }) {
  return (
    <div className={styles.abar}>
      <p className={styles.abHint}>{AGENTS_HINT}</p>
      <div className={styles.abRow}>
        <CopyButton
          value={buildApplyAgentPrompt(job)}
          label="Copy prompt"
          copiedLabel="Copied"
          icon={<CopyIcon />}
          className={`${styles.btn} ${styles.pri} ${styles.grow}`}
          copiedNote="Copied. Paste it into your agent on your computer."
          noteClassName={styles.abNote}
        />
        <a className={`${styles.btn} ${styles.btn2}`} href={job.url} target="_blank" rel="noopener noreferrer">
          Open posting
          <ExternalIcon />
        </a>
      </div>
    </div>
  );
}

export function JobDetail({
  job,
  similar,
  jsonLd,
  now,
}: {
  job: BoardJob & { closedAt?: string | null };
  similar: BoardJob[];
  jsonLd: Record<string, unknown>;
  now: number;
}) {
  const closed = job.livenessStatus === "closed";
  const posted = employerPostedAt(job, now);
  const department = job.location?.department ?? "";
  const meta = [posted ? `Posted ${formatReviewedDate(posted)}` : "", department].filter(Boolean).join(" · ");
  const ats = channelLabel(job.applicationChannel);
  const checked = formatReviewedDate(job.lastCheckedAt ?? job.lastSeenAt);

  return (
    <div className={`${styles.container}${closed ? "" : ` ${styles.hasBar}`}`}>
      <SiteHeader foundingCta={false} />
      <main className={`page-width ${styles.page} ${styles.detailPage}`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <Link href="/jobs" className={styles.back}>
          <BackIcon />
          All roles
        </Link>
        {closed ? (
          <>
            <section className={styles.dh}>
              <h1>{job.role}</h1>
              <p className={styles.co}>{job.company}</p>
            </section>
            <div className={styles.closed} role="status">
              <p className={styles.eT}>
                This role closed on {formatClosedDate(job.closedAt ?? job.lastCheckedAt ?? job.lastSeenAt)}.
              </p>
              <p className={styles.eB}>
                Our daily check found the employer&apos;s posting had come down, so the role left the board.
              </p>
            </div>
            {similar.length > 0 ? (
              <section className={styles.sim} aria-labelledby="similar-heading">
                <h2 id="similar-heading">Similar open roles</h2>
                <div className={styles.list}>
                  {similar.map((role) => <JobRow key={role.jobId} job={role} now={now} />)}
                </div>
              </section>
            ) : null}
            <p className={styles.simMore}>
              <Link href="/jobs" className={`${styles.btn} ${styles.btn2}`}>See all open roles</Link>
            </p>
          </>
        ) : (
          <div className={styles.dd}>
            <article className={styles.article}>
              <section className={styles.dh}>
                <h1>{job.role}</h1>
                <p className={styles.co}>{job.company}</p>
                {meta ? <p className={styles.meta}>{meta}</p> : null}
              </section>
              <Facts job={job} />
              <p className={styles.prov}>
                {ats && ats !== job.company ? `From ${job.company}'s ${ats} posting.` : `From ${job.company}'s posting.`}
                {checked ? ` Checked ${checked}.` : ""}
              </p>
              <a className={styles.tl} href={job.url} target="_blank" rel="noopener noreferrer">
                {postingLabel(job, "Read the full posting")}
                <ExternalIcon />
              </a>
            </article>
            <aside className={styles.rail} aria-label="Apply with your agent">
              <ApplyCard job={job} />
            </aside>
          </div>
        )}
      </main>
      {closed ? null : <ApplyBar job={job} />}
      <SiteFooter />
    </div>
  );
}
