import {
  getLaunchDisplayState,
  HOSTED_CONTINUITY_STATUS,
} from "../../lib/launch-countdown.mjs";

export function LaunchCountdown() {
  const display = getLaunchDisplayState({
    hostedContinuityStatus: HOSTED_CONTINUITY_STATUS,
  });

  return <section className="launch-countdown" aria-labelledby="launch-countdown-title">
    <div className="launch-countdown-heading">
      <div><p className="eyebrow">Pre-launch run</p><h2 id="launch-countdown-title">Cloud launch sequence</h2></div>
      <span className="launch-state"><i aria-hidden="true" />{display.launchStateLabel}</span>
    </div>

    <div className="launch-target">
      <span>Availability</span>
      <strong className="launch-soft-timing">Coming soon</strong>
    </div>

    <div className="launch-sequence" aria-label="Launch readiness">
      <div><span>Agent foundation</span><strong>RELEASED</strong></div>
      <div><span>Hosted continuity</span><strong>{display.hostedContinuityLabel}</strong></div>
      <div><span>Cloud access</span><strong>{display.cloudAccessLabel}</strong></div>
    </div>

    <p className="launch-message" aria-live="polite">{display.message}</p>
  </section>;
}
