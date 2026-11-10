"use client";

import { useState, type FormEvent } from "react";
import styles from "./jobs.module.css";

type Phase = "idle" | "editing" | "done" | "active";
type Cadence = "daily" | "weekly";

export function SaveSearch({ filterQuery }: { filterQuery: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [email, setEmail] = useState("");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/jobs/alerts", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email, cadence, filterQuery }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; state?: string };
      if (!response.ok) {
        setError(typeof data.error === "string" ? data.error : "Couldn't save this search.");
        return;
      }
      setPhase(data.state === "active" ? "active" : "done");
    } catch {
      setError("Couldn't save this search.");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "done") return <p className={styles.saveNote} role="status">Check your inbox to confirm.</p>;
  if (phase === "active") return <p className={styles.saveNote} role="status">This search is already on.</p>;
  if (phase === "idle") {
    return (
      <div className={styles.save}>
        <button type="button" className={`${styles.btn} ${styles.btn2}`} onClick={() => setPhase("editing")}>
          Save this search
        </button>
      </div>
    );
  }

  return (
    <form className={styles.save} onSubmit={onSubmit}>
      <label className={styles.field}>
        <span className={styles.sr}>Email</span>
        <input
          type="email"
          required
          autoComplete="email"
          placeholder="Email"
          value={email}
          maxLength={254}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <div className={styles.saveCadence} role="group" aria-label="How often">
        <button type="button" aria-pressed={cadence === "daily"} className={`${styles.tg}${cadence === "daily" ? ` ${styles.tgOn}` : ""}`} onClick={() => setCadence("daily")}>Daily</button>
        <button type="button" aria-pressed={cadence === "weekly"} className={`${styles.tg}${cadence === "weekly" ? ` ${styles.tgOn}` : ""}`} onClick={() => setCadence("weekly")}>Weekly</button>
      </div>
      <button type="submit" className={`${styles.btn} ${styles.pri}`} disabled={busy}>Save</button>
      {error ? <p className={styles.saveErr} role="alert">{error}</p> : null}
    </form>
  );
}
