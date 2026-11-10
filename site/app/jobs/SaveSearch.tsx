"use client";

import { useState, type FormEvent } from "react";
import { activeFilterChips, parseBoardQuery } from "../../lib/jobs-board-query.mjs";
import styles from "./jobs.module.css";

type Phase = "idle" | "editing" | "done" | "active";
type Cadence = "daily" | "weekly";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function searchLabel(filterQuery: string) {
  const chips = activeFilterChips(parseBoardQuery(new URLSearchParams(filterQuery)));
  return chips.length ? chips.map((chip) => chip.label).join(", ") : "all new roles";
}

export function SaveSearch({ filterQuery }: { filterQuery: string }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [email, setEmail] = useState("");
  const [cadence, setCadence] = useState<Cadence>("daily");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const label = searchLabel(filterQuery);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entered = email.trim();
    if (!EMAIL_PATTERN.test(entered) || entered.length > 254) {
      setError("Enter a valid email.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/jobs/alerts", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ email: entered, cadence, filterQuery }),
      });
      const data = await response.json().catch(() => ({})) as { error?: string; state?: string };
      if (!response.ok) {
        const message = typeof data.error === "string" ? data.error : "Couldn't save this search.";
        setError(message.startsWith("Enter a valid email") ? "Enter a valid email." : message);
        return;
      }
      setEmail(entered);
      setPhase(data.state === "active" ? "active" : "done");
    } catch {
      setError("Couldn't save this search.");
    } finally {
      setBusy(false);
    }
  }

  if (phase === "idle") {
    return (
      <div className={styles.save}>
        <button type="button" className={`${styles.btn} ${styles.btn2}`} onClick={() => setPhase("editing")}>
          Save this search
        </button>
      </div>
    );
  }

  const status = phase === "done"
    ? `Check ${email} to confirm.`
    : phase === "active"
      ? "This search is already on."
      : "";

  return (
    <div className={styles.save}>
      <p className={styles.saveFor}>Alerts for {label}</p>
      {status ? (
        <div className={styles.saveRow}>
          <p className={styles.saveNote} role="status">{status}</p>
        </div>
      ) : (
        <form className={styles.saveRow} onSubmit={onSubmit} noValidate>
          <label className={styles.field}>
            <span className={styles.sr}>Email</span>
            <input
              type="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              maxLength={254}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "save-email-error" : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                if (error) setError("");
              }}
            />
            {error ? <span id="save-email-error" className={styles.saveErr} role="alert">{error}</span> : null}
          </label>
          <div className={styles.saveSeg} role="group" aria-label="How often">
            <button type="button" aria-pressed={cadence === "daily"} onClick={() => setCadence("daily")}>Daily</button>
            <button type="button" aria-pressed={cadence === "weekly"} onClick={() => setCadence("weekly")}>Weekly</button>
          </div>
          <button type="submit" className={`${styles.btn} ${styles.pri} ${styles.saveSubmit}`} disabled={busy}>Save</button>
        </form>
      )}
    </div>
  );
}
