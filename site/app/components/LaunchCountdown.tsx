"use client";

import { useEffect, useState } from "react";
import {
  getCountdownParts,
  getLaunchDisplayState,
  HOSTED_CONTINUITY_STATUS,
} from "../../lib/launch-countdown.mjs";

type LaunchCountdownProps = {
  releaseAt: string;
};

type CountdownParts = ReturnType<typeof getCountdownParts>;

const units = [
  ["days", "Days"],
  ["hours", "Hours"],
  ["minutes", "Minutes"],
  ["seconds", "Seconds"],
] as const;

function formatUnit(value: number) {
  return String(value).padStart(2, "0");
}

export function LaunchCountdown({ releaseAt }: LaunchCountdownProps) {
  const [remaining, setRemaining] = useState<CountdownParts | null>(null);

  useEffect(() => {
    const initial = getCountdownParts(releaseAt);
    const initialUpdate = window.setTimeout(() => setRemaining(initial), 0);
    if (initial.complete) return () => window.clearTimeout(initialUpdate);

    const interval = window.setInterval(() => {
      const next = getCountdownParts(releaseAt);
      setRemaining(next);
      if (next.complete) window.clearInterval(interval);
    }, 1_000);
    return () => {
      window.clearTimeout(initialUpdate);
      window.clearInterval(interval);
    };
  }, [releaseAt]);

  const display = remaining
    ? getLaunchDisplayState({
      complete: remaining.complete,
      hostedContinuityStatus: HOSTED_CONTINUITY_STATUS,
    })
    : null;

  return <section className={`launch-countdown${display?.timerComplete ? " launch-countdown-complete" : ""}`} aria-labelledby="launch-countdown-title">
    <div className="launch-countdown-heading">
      <div><p className="eyebrow">Pre-launch run</p><h2 id="launch-countdown-title">Cloud launch sequence</h2></div>
      <span className="launch-state"><i aria-hidden="true" />{display ? display.launchStateLabel : "SYNCING"}</span>
    </div>

    <div className="countdown-grid" role="timer" aria-label="Time remaining until cloud launch">
      {units.map(([key, label]) => <div className="countdown-unit" key={key}>
        <strong>{remaining ? formatUnit(remaining[key]) : "--"}</strong>
        <span>{label}</span>
      </div>)}
    </div>

    <div className="launch-target">
      <span>Scheduled start</span>
      <time dateTime={releaseAt}>October 1, 2026 · 12:00 AM IST</time>
    </div>

    <div className="launch-sequence" aria-label="Launch readiness">
      <div><span>Agent foundation</span><strong>RELEASED</strong></div>
      <div><span>Hosted continuity</span><strong>{display?.hostedContinuityLabel ?? HOSTED_CONTINUITY_STATUS}</strong></div>
      <div><span>Cloud access</span><strong>{display?.cloudAccessLabel ?? "SCHEDULED"}</strong></div>
    </div>

    <p className="launch-message" aria-live="polite">{display ? display.message : "Synchronizing with the launch schedule…"}</p>
  </section>;
}
