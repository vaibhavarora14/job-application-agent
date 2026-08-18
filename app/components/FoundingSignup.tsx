"use client";

import { FormEvent, useState } from "react";

type Stage = "form" | "saving" | "offer" | "checkout" | "done";
type ApiResult = { error?: string; fields?: Record<string, string>; registrationId?: string; checkoutUrl?: string };

export function FoundingSignup() {
  const [stage, setStage] = useState<Stage>("form");
  const [registrationId, setRegistrationId] = useState("");
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [trialFirst, setTrialFirst] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(""); setFields({}); setStage("saving");
    const form = new FormData(event.currentTarget);
    const source = new URLSearchParams(window.location.search).get("utm_source") ?? document.referrer.slice(0, 100);
    const response = await fetch("/api/founding", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), targetRole: form.get("targetRole"), targetLocation: form.get("targetLocation"), company: form.get("company"), source }),
    });
    const result = await response.json() as ApiResult;
    if (!response.ok || !result.registrationId) {
      setError(result.error ?? "Registration is temporarily unavailable.");
      setFields(result.fields ?? {}); setStage("form"); return;
    }
    setRegistrationId(result.registrationId); setStage("offer");
  }

  async function recordIntent(intent: "ready_to_pay" | "needs_trial") {
    setStage("checkout"); setError("");
    const intentResponse = await fetch("/api/founding/intent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ registrationId, intent }),
    });
    const intentResult = await intentResponse.json() as ApiResult;
    if (!intentResponse.ok) { setError(intentResult.error ?? "We could not save that choice."); setStage("offer"); return; }
    if (intent === "needs_trial") { setTrialFirst(true); setStage("done"); return; }
    const checkoutResponse = await fetch("/api/checkout", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ registrationId }),
    });
    const checkoutResult = await checkoutResponse.json() as ApiResult;
    if (!checkoutResponse.ok || !checkoutResult.checkoutUrl) {
      setError(checkoutResult.error ?? "Secure checkout is temporarily unavailable."); setStage("offer"); return;
    }
    window.location.assign(checkoutResult.checkoutUrl);
  }

  return <section className="founding-card" aria-labelledby="founding-title">
    <div className="founding-copy">
      <p className="eyebrow">Founding cloud beta</p>
      <h2 id="founding-title">Help shape the agent that keeps running.</h2>
      <p>Join the first 50 people invited after the first verified production run. Registration is free; founding access is a one-time $49 for 90 days.</p>
      <ul><li>90 days of founding access</li><li>Direct line to the builder</li><li>Secure checkout by Dodo Payments</li><li>Local agent stays free and open</li></ul>
    </div>
    <div className="signup-panel" aria-live="polite">
      {(stage === "form" || stage === "saving") && <form onSubmit={submit} aria-busy={stage === "saving"}>
        <label>Email<input name="email" type="email" autoComplete="email" required aria-invalid={Boolean(fields.email)} /></label>
        {fields.email && <small className="field-error">{fields.email}</small>}
        <label>What role should the agent search for?<input name="targetRole" type="text" maxLength={120} required aria-invalid={Boolean(fields.targetRole)} /></label>
        {fields.targetRole && <small className="field-error">{fields.targetRole}</small>}
        <label>Preferred location <span>(optional)</span><input name="targetLocation" type="text" maxLength={100} placeholder="Remote, Bengaluru, London…" /></label>
        <label className="honeypot" aria-hidden="true">Company<input name="company" tabIndex={-1} autoComplete="off" /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="button" disabled={stage === "saving"}>{stage === "saving" ? "Saving…" : "Join early access →"}</button>
        <small>One useful launch email, then product updates. Unsubscribe anytime.</small>
      </form>}
      {(stage === "offer" || stage === "checkout") && <div className="intent-step">
        <span className="success-mark">✓</span><h3>You&apos;re registered.</h3>
        <p>Reserve 90 days of founding cloud access for <strong>$49 one-time</strong>, or tell us you need to try it first.</p>
        {error && <p className="form-error">{error}</p>}
        <button className="button" disabled={stage === "checkout"} onClick={() => recordIntent("ready_to_pay")}>{stage === "checkout" ? "Opening checkout…" : "Continue to secure checkout →"}</button>
        <button className="text-button" disabled={stage === "checkout"} onClick={() => recordIntent("needs_trial")}>I need to try it first</button>
        <small>Secure checkout by Dodo Payments. We never receive or store your card details.</small>
      </div>}
      {stage === "done" && <div className="intent-step">
        <span className="success-mark">✓</span><h3>Thank you. That answer helps.</h3>
        <p>{trialFirst ? "We'll invite you when a trial place is ready." : "We'll email you when the first cloud places are ready."}</p>
        <a href="https://github.com/vaibhavarora14/job-application-agent">Use the local agent today →</a>
      </div>}
    </div>
  </section>;
}
