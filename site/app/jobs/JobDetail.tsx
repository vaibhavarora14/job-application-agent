import Link from "next/link";
import {
  TRUST_LINE,
  classifyRoleFamily,
  formatClosedDate,
  formatReviewedDate,
  locationLabel,
  employerPostedAt,
  payRows,
} from "../../lib/live-jobs.mjs";
import { buildApplyCliCommand, shortenUrlForDisplay } from "../../lib/job-apply-copy.mjs";
import { CopyButton } from "./CopyButton";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";
import styles from "./jobs.module.css";
import type { BoardJob } from "./JobsBoard";

function ApplyPanel({ job }: { job: BoardJob }) {
  // `apply <url>` ships in npm 3.7.7+ (review-mode prompt printer).
  const applyCmd = buildApplyCliCommand(job.url);
  const applyDisplay = `npx job-application-agent@latest apply ${shortenUrlForDisplay(job.url)}`;
  return (
    <aside className={styles.panel} aria-label="Apply with your agent">
      <h2>Apply with your agent</h2>
      <p className={styles.panelLead}>
        Run apply in review mode. You approve the draft before anything is submitted.
      </p>
      <div className={styles.step}>
        <span className={styles.stepNum}>01</span>
        <div className={styles.stepBody}>
          <div className={styles.stepTitle}>Apply in review mode</div>
          <div className={styles.codeRow}>
            <div className={styles.codeScrollWrap}>
              <div className={styles.codeScroll}>
                <code title={applyCmd}>{applyDisplay}</code>
              </div>
            </div>
            <CopyButton value={applyCmd} />
          </div>
        </div>
      </div>
      <a className={styles.original} href={job.url} target="_blank" rel="noopener noreferrer">
        Open original posting ↗
      </a>
    </aside>
  );
}

function SimilarList({ jobs }: { jobs: BoardJob[] }) {
  if (jobs.length === 0) return null;
  return (
    <section aria-labelledby="similar-heading">
      <h2 id="similar-heading" className={styles.similarHeading}>Similar open roles</h2>
      <div className={styles.list}>
        {jobs.map((job) => (
          <div key={job.jobId}>
            <div className={styles.jobRow}>
              <span className={styles.company}>{job.company}</span>
              <span className={styles.title}>{job.role}</span>
              <span className={styles.location}>{locationLabel(job) || "—"}</span>
              <span className={styles.metaDate}>
                Reviewed {formatReviewedDate(job.lastCheckedAt ?? job.lastSeenAt)}
              </span>
              <Link href={`/jobs/${job.slug}`} className={styles.applyBtn}>
                Apply with your agent
              </Link>
            </div>
            <div className={styles.mobileCard}>
              <p className={styles.mobileTitle}>{job.role}</p>
              <p className={styles.mobileMeta}>
                {job.company}
                {locationLabel(job) ? ` · ${locationLabel(job)}` : ""}
                <br />
                <span className={styles.metaDate}>
                  Reviewed {formatReviewedDate(job.lastCheckedAt ?? job.lastSeenAt)}
                </span>
              </p>
              <Link href={`/jobs/${job.slug}`} className={styles.applyBtn}>
                Apply with your agent
              </Link>
            </div>
          </div>
        ))}
      </div>
      <p style={{ marginTop: "1.25rem" }}>
        <Link href="/jobs" className="button button-secondary">See all open roles</Link>
      </p>
    </section>
  );
}

export function JobDetail({
  job,
  similar,
  jsonLd,
}: {
  job: BoardJob & { closedAt?: string | null };
  similar: BoardJob[];
  jsonLd: Record<string, unknown>;
}) {
  const closed = job.livenessStatus === "closed";
  const family = classifyRoleFamily(job.role);
  const place = locationLabel(job);
  // Employer-stated facts only: unknown pay reads "Pay not listed"; other unknown facts are omitted.
  // Several employer bands (zones, levels, currencies) are listed each with its name (max 4, then "+N more bands").
  const pay = payRows(job);
  const posted = employerPostedAt(job);
  const employment = job.location?.employmentType
    ? job.location.employmentType.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "";

  return (
    <div className={styles.container}>
      <SiteHeader foundingCta={false} />
      <main className={`page-width ${styles.page}`}>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        {closed ? (
          <>
            <p className={styles.crumb}>
              <Link href="/jobs">Jobs</Link>
              {" / "}
              {family}
            </p>
            <div className={styles.detailHero}>
              <h1>{job.role}</h1>
              <p className={styles.companyLine}>
                {job.company}
                {place ? ` · ${place}` : ""}
              </p>
            </div>
            <div className={styles.closed} role="status">
              <div className={styles.closedEyebrow}>CLOSED</div>
              <p className={styles.closedTitle}>
                This role closed on {formatClosedDate(job.closedAt ?? job.lastCheckedAt ?? job.lastSeenAt)}.
              </p>
              <p className={styles.closedBody}>
                Our daily check found the employer&apos;s posting had come down, so the role was removed from the board.
                Summary and apply commands are hidden for closed roles.
              </p>
            </div>
            <SimilarList jobs={similar} />
          </>
        ) : (
          <div className={styles.detailLayout}>
            <div className={styles.detailMain}>
              <p className={styles.crumb}>
                <Link href="/jobs">Jobs</Link>
                {" / "}
                {family}
              </p>
              <div className={styles.detailHero}>
                <h1>{job.role}</h1>
                <p className={styles.companyLine}>{job.company}</p>
                <p className={styles.trust}>
                  <span className={styles.trustDot} aria-hidden="true" />
                  {TRUST_LINE}
                </p>
              </div>
              <div className={styles.facts}>
                {place ? (
                  <div>
                    <strong>Location</strong>
                    {place}
                  </div>
                ) : null}
                {employment ? (
                  <div>
                    <strong>Type</strong>
                    {employment}
                  </div>
                ) : null}
                {posted ? (
                  <div>
                    <strong>Posted</strong>
                    {formatClosedDate(posted)}
                  </div>
                ) : null}
                <div>
                  <strong>Pay</strong>
                  {!pay ? (
                    "Pay not listed"
                  ) : pay.single ? (
                    pay.single
                  ) : (
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
                  )}
                </div>
              </div>
              <div className={styles.summary}>
                <p>
                  Maintainer-reviewed opening at {job.company}. We show only facts from the community registry
                  and the employer&apos;s public posting — nothing invented.
                </p>
                <h2>How applying works here</h2>
                <p>
                  Your agent fills the application on the employer&apos;s own site, using only facts from your profile.
                  Anything it can&apos;t verify comes back to you. Nothing you share is stored on this board.
                </p>
                <p className={styles.metaDate}>
                  Last checked {formatReviewedDate(job.lastCheckedAt ?? job.lastSeenAt)}
                </p>
              </div>
            </div>
            <ApplyPanel job={job} />
          </div>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
