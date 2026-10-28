import styles from "./jobs.module.css";

export function JobRowSkeleton() {
  return (
    <div className={styles.sk} aria-hidden="true">
      <span className={`${styles.skb} ${styles.w70}`} />
      <span className={`${styles.skb} ${styles.w45}`} />
      <span className={`${styles.skb} ${styles.w30} ${styles.chipb}`} />
    </div>
  );
}
