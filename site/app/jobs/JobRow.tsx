import Link from "next/link";
import { employerSalary, postedDate } from "../../lib/live-jobs.mjs";
import { compactLocation, shortPostedLabel, workplaceLabel } from "../../lib/jobs-board-query.mjs";
import styles from "./jobs.module.css";
import type { BoardJob } from "./JobsBoard";

/**
 * One role as a single link. Stacks as a card on narrow lists and becomes a
 * ~64px row (title/company · location · workplace · pay · posted) at 840px+.
 * At most two chips (workplace, pay); no pay → no chip and no placeholder text.
 */
export function JobRow({ job, now }: { job: BoardJob; now: number }) {
  const place = compactLocation(job);
  const workplace = workplaceLabel(job);
  const pay = employerSalary(job)?.label ?? null;
  const posted = shortPostedLabel(postedDate(job, now), now);
  return (
    <Link href={`/jobs/${job.slug}`} className={styles.job}>
      <span className={styles.jTitle}>{job.role}</span>
      <span className={styles.jCo}>{job.company}</span>
      {place ? <span className={styles.jLoc}>{place}</span> : <span className={styles.jLocEmpty} aria-hidden="true" />}
      {workplace || pay ? (
        <span className={styles.jFacts}>
          <span className={styles.jWork}>{workplace ? <span className={styles.chip}>{workplace}</span> : null}</span>
          <span className={styles.jPay}>{pay ? <span className={`${styles.chip} ${styles.chipPay}`}>{pay}</span> : null}</span>
        </span>
      ) : null}
      {posted ? <span className={styles.jDate}>{posted}</span> : null}
    </Link>
  );
}
