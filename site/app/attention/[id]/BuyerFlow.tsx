"use client";

import { useEffect, useRef, useState } from "react";
import { BUYER_FLOW_COPY, canContinueApplying, chooseActionLabel } from "../../../lib/attention-buyer-flow.mjs";
import { ATTENTION_DESIGN_STEPS } from "../../../lib/attention-design-fixtures.mjs";
import { AttentionAnswerFields } from "./AttentionAnswerFields";
import { useAttentionActions, type AttentionAction, type AttentionView } from "./AttentionActions";
import { AdminPreviewCard, ChooseCard, FlowCard, PreflightCard, QueueCard } from "./BuyerFlowCards";

export type BuyerStep = "preflight" | "choose" | "queue" | "judgment" | "done" | "admin";
export function BuyerFlow({ view, initialStep, designFixture = false, initialSignal = null }: {
  view: AttentionView; initialStep: BuyerStep; designFixture?: boolean; initialSignal?: string | null;
}) {
  const [step, setStep] = useState<BuyerStep>(initialStep);
  const [viewport, setViewport] = useState("mobile");
  const [selected, setSelected] = useState(["acme", "northstar", "fieldkit"]);
  const [expanded, setExpanded] = useState(false);
  const [settled, setSettled] = useState<string | null>(initialSignal);
  const [notice, setNotice] = useState<string | null>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const { answers, busy, error, setAnswer, send } = useAttentionActions(view, designFixture);
  const admin = designFixture && step === "admin";
  const stopped = settled === "skipped" || settled === "aborted";
  const copy = admin ? {
    eyebrow: "", title: "", pill: "Needs live fix",
    prompt: "Buyer is not interrupted. Job stays in-progress in their queue until ops resolves this.", primary: "Open session",
  } : BUYER_FLOW_COPY[step === "admin" ? "queue" : step];
  const isRole = step === "judgment" || step === "done" || admin;
  const primary = step === "choose" ? chooseActionLabel(selected.length) : copy.primary;
  const disabled = busy || (step === "choose" && !selected.length)
    || (step === "judgment" && !canContinueApplying(view.questions, answers));

  useEffect(() => {
    if (expanded) document.getElementById("buyer-queue-list")?.focus();
  }, [expanded]);

  useEffect(() => {
    function closeMenu(event: KeyboardEvent) {
      if (event.key === "Escape" && menu.current?.open) {
        menu.current.open = false;
        menu.current.querySelector("summary")?.focus();
      }
    }
    window.addEventListener("keydown", closeMenu);
    return () => window.removeEventListener("keydown", closeMenu);
  }, []);

  function go(next: BuyerStep) {
    setStep(next);
    setExpanded(false);
    setNotice(null);
    if (menu.current) menu.current.open = false;
    if (designFixture) {
      const url = new URL(window.location.href);
      url.searchParams.set("design", next);
      window.history.replaceState({}, "", url);
    }
    title.current?.focus();
  }

  async function act(action: AttentionAction) {
    if (!await send(action)) return;
    setSettled(action === "resume" ? "resume_requested" : action === "skip" ? "skipped" : "aborted");
    go("queue");
  }

  function primaryAction() {
    if (step === "judgment") { void act("resume"); return; }
    if (step === "queue") { setExpanded(!expanded); return; }
    if (!designFixture) return;
    if (step === "preflight") go("choose");
    if (step === "choose") go("queue");
    if (step === "done") { setSettled(null); go("choose"); }
    if (admin) setNotice("Design-only preview — no session is opened and no alert is sent.");
  }

  return <main className={`buyer-flow${designFixture ? ` buyer-preview buyer-preview-${viewport}` : ""}`} data-design-fixture={designFixture ? step : undefined}>
    {designFixture && <nav className="buyer-design-strip" aria-label="Design preview controls">
      <strong>Design</strong>
      <div aria-label="Workflow step"><span>Step</span>{ATTENTION_DESIGN_STEPS.map((item) => <button type="button" key={item} className={item === "admin" ? "buyer-admin-control" : undefined} aria-pressed={step === item} onClick={() => { setSettled(null); go(item as BuyerStep); }}>{item}</button>)}</div>
      <div aria-label="Viewport"><span>Viewport</span>{["mobile", "laptop"].map((item) => <button type="button" key={item} aria-pressed={viewport === item} onClick={() => setViewport(item)}>{item}</button>)}</div>
      <small>Design fixture only · Sample data</small>
    </nav>}
    <div className="buyer-stage">
      <section className={`buyer-screen${admin ? " buyer-admin" : ""}`} aria-label={admin ? "Admin design preview" : "Application workflow"}>
        {admin && <div className="buyer-admin-banner">ADMIN ONLY · DESIGN-ONLY · NOT BUYER UI</div>}
        <div className="buyer-topbar">
          <a href={designFixture ? "/attention/design?design=preflight" : "/"}>‹ <span>JobAppAgent</span></a>
          {!admin && !stopped && ["queue", "judgment"].includes(step) && <details ref={menu} className="buyer-menu">
            <summary aria-label="More application options">⋯</summary>
            <div><button type="button" disabled={busy} onClick={() => void act("skip")}>Skip this role</button>
              <button type="button" disabled={busy} onClick={() => void act("abort")}>Stop application</button></div>
          </details>}
        </div>
        <header className="buyer-header">
          {copy.eyebrow && !stopped && <p className="buyer-eyebrow">{copy.eyebrow}</p>}
          <h1 ref={title} tabIndex={-1}>{stopped ? view.role : isRole ? view.role : copy.title}</h1>
          <p className="buyer-company">{isRole || stopped ? view.company : "JobAppAgent"}</p>
          <span className="buyer-pill" aria-live="polite">{stopped ? settled === "skipped" ? "Skipped" : "Stopped" : step === "choose" ? `${selected.length} selected` : copy.pill}</span>
          <p className="buyer-prompt">{stopped ? "Your choice is saved." : step === "judgment" && view.questions.length > 1
            ? "A few questions from the employer need your input before we continue applying." : copy.prompt}</p>
        </header>
        <div className="buyer-content">
          {stopped ? <FlowCard title={settled === "skipped" ? "Role skipped" : "Application stopped"} body="Your request has been sent. This is not an application confirmation." /> : <>
            {step === "preflight" && designFixture && <PreflightCard />}
            {step === "choose" && designFixture && <ChooseCard selected={selected} toggle={(id) => setSelected((previous) => previous.includes(id) ? previous.filter((item) => item !== id) : [...previous, id])} />}
            {step === "queue" && <QueueCard count={designFixture ? selected.length : 1} expanded={expanded} role={view.role} company={view.company} selected={designFixture ? selected : undefined} />}
            {step === "judgment" && <fieldset className="buyer-answer-fields" disabled={busy}><legend className="sr-only">Employer questions</legend><AttentionAnswerFields {...view} answers={answers} onChange={setAnswer} designFixture={designFixture} /></fieldset>}
            {step === "done" && designFixture && <FlowCard title="Application confirmed" body="Submitted on the employer site. No further action needed for this role." />}
            {admin && <AdminPreviewCard />}
          </>}
        </div>
        <div className="buyer-footer">
          {error && <p role="alert" className="buyer-save-note">{error}</p>}
          {notice && <p role="status" className="buyer-save-note">{notice}</p>}
          {stopped ? <a className="buyer-primary" href={designFixture ? "/attention/design?design=choose" : "/"}>Back to search</a>
            : <button type="button" className="buyer-primary" disabled={disabled} onClick={primaryAction} aria-expanded={step === "queue" ? expanded : undefined}>{busy ? "Saving…" : primary}</button>}
        </div>
      </section>
    </div>
  </main>;
}
