"use client";

import { FormEvent, useState } from "react";
type Stage = "form" | "saving" | "offer" | "intent" | "done";

export function FoundingSignup() {
  const [stage, setStage] = useState<Stage>("form");
  const [registrationId, setRegistrationId] = useState("");
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); setFields({}); setStage("saving");
    const form = new FormData(event.currentTarget);
    const source = new URLSearchParams(window.location.search).get("utm_source") ?? document.referrer.slice(0, 100);
    const response = await fetch("/api/founding", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: form.get("email"), targetRole: form.get("targetRole"), targetLocation: form.get("targetLocation"), company: form.get("company"), source }) });
    const result = await response.json();
    if (!response.ok) { setError(result.error); setFields(result.fields ?? {}); setStage("form"); return; }
    setRegistrationId(result.registrationId); setStage("offer");
  }
  async function recordIntent(intent: "ready_to_pay" | "needs_trial") {
    setStage("intent"); setError("");
    const response = await fetch("/api/founding/intent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registrationId, intent }) });
    if (!response.ok) { const result = await response.json(); setError(result.error); setStage("offer"); return; }
    setStage("done");
  }
  return <section className="founding-card" aria-labelledby="founding-title"><div className="founding-copy"><p className="eyebrow">Founding cloud beta</p><h2 id="founding-title">Help shape the agent that keeps running.</h2><p>Join the first 50 people invited after the first verified production run. Registration is free. We ask about paid intent only after you join.</p><ul><li>90 days of founding access</li><li>Direct line to the builder</li><li>Local agent stays free and open</li></ul></div><div className="signup-panel" aria-live="polite">
    {(stage === "form" || stage === "saving") && <form onSubmit={submit} aria-busy={stage === "saving"}><label>Email<input name="email" type="email" autoComplete="email" required aria-invalid={Boolean(fields.email)} /></label>{fields.email && <small className="field-error">{fields.email}</small>}<label>What role should the agent search for?<input name="targetRole" type="text" maxLength={120} required aria-invalid={Boolean(fields.targetRole)} /></label>{fields.targetRole && <small className="field-error">{fields.targetRole}</small>}<label>Preferred location <span>(optional)</span><input name="targetLocation" type="text" maxLength={100} placeholder="Remote, Bengaluru, London…" /></label><label className="honeypot" aria-hidden="true">Company<input name="company" tabIndex={-1} autoComplete="off" /></label>{error && <p className="form-error">{error}</p>}<button className="button" disabled={stage === "saving"}>{stage === "saving" ? "Saving…" : "Join early access →"}</button><small>One useful launch email, then product updates. Unsubscribe anytime.</small></form>}
    {(stage === "offer" || stage === "intent") && <div className="intent-step"><span className="success-mark">✓</span><h3>You&apos;re registered.</h3><p>If the cloud agent works as described, would <strong>$49 for your first 90 days</strong> feel fair?</p>{error && <p className="form-error">{error}</p>}<button className="button" disabled={stage === "intent"} onClick={() => recordIntent("ready_to_pay")}>Yes, I&apos;m ready to pay</button><button className="text-button" disabled={stage === "intent"} onClick={() => recordIntent("needs_trial")}>I need to try it first</button><small>This records intent only. No card, charge, or checkout yet.</small></div>}
    {stage === "done" && <div className="intent-step"><span className="success-mark">✓</span><h3>Thank you. That answer helps.</h3><p>We&apos;ll email you when the first cloud places are ready.</p><a href="https://github.com/vaibhavarora14/job-application-agent">Use the local agent today →</a></div>}
  </div></section>;
}
