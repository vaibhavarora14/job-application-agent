import {
  getLaunchDisplayState,
  CLOUD_ACCESS_STATUS,
} from "../../lib/launch-countdown.mjs";

export function LaunchCountdown() {
  const display = getLaunchDisplayState({
    cloudAccessStatus: CLOUD_ACCESS_STATUS,
  });

  return <section className="launch-countdown" aria-labelledby="launch-countdown-title">
    <div className="launch-countdown-heading">
      <div><p className="eyebrow">Launch readiness</p><h2 id="launch-countdown-title">Cloud access</h2></div>
      <span className="launch-state"><i aria-hidden="true" />{display.launchStateLabel}</span>
    </div>

    <div className="launch-target">
      <span>Availability</span>
      <strong className="launch-soft-timing">{display.availabilityLabel}</strong>
    </div>

    <div className="launch-sequence" aria-label="Launch readiness">
      <div><span>Agent foundation</span><strong>RELEASED</strong></div>
      <div><span>Cloud access</span><strong>{display.cloudAccessLabel}</strong></div>
    </div>

    <p className="launch-message" aria-live="polite">{display.message}</p>
    <p className="launch-support">Smarter agent on cloud.</p>
  </section>;
}
