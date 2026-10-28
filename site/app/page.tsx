import type { Metadata } from "next";
import Link from "next/link";
import { CommunityProof } from "./components/CommunityProof";
import { CopyCode } from "./components/CopyCode";
import { FoundingCheckout } from "./components/FoundingCheckout";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";

export const metadata: Metadata = {
  title: { absolute: "JobAppAgent — open-source AI job application agent" },
  description: "JobAppAgent is an open-source AI job application agent that discovers, qualifies, applies, pauses for judgment, and keeps a verified record while you are away.",
  alternates: { canonical: "https://jobappagent.com" },
};

const REPO = "https://github.com/vaibhavarora14/job-application-agent";
const INSTALL = "npx job-application-agent@latest install";

/*
 * Information architecture: one path, free first, paid next.
 *   Hero      — the three-step path: 1 run the free open-source agent → 2 browse /jobs → 3 reserve Cloud.
 *   Proof     — lifetime community counters (real telemetry only).
 *   #free     — Available now: #agent (npm/GitHub install) and #jobs (job board).
 *   #process  — How it works: the loop plus agent-handles / you-handle (#boundaries).
 *   #cloud    — the paid $49 founding reservation IS the Cloud interest capture (no free waitlist):
 *               the dark offer card + a dateless progress checklist (founder note behind a flag, off).
 *   FAQ.
 * Each block is data-driven below so copy and order can change without touching layout.
 */
const path = [
  { id: "agent", step: "1", name: "Run the open-source agent", tag: "Free · MIT", body: "Install it into Cursor, Claude Code, Codex or another coding agent on your computer.", href: "/#agent", cta: "Install the agent" },
  { id: "jobs", step: "2", name: "Browse the job board", tag: "Free", body: "Reviewed open roles, checked daily. Copy a role’s prompt and your agent applies.", href: "/jobs", cta: "Browse open roles" },
  { id: "cloud", step: "3", name: "Reserve Cloud", tag: "Founding reservation · $49", body: "Smarter agent on cloud. It runs the search for you.", href: "/#cloud", cta: "Reserve founding access" },
] as const;

const steps = [
  ["01", "Set the boundaries", "Choose roles, locations, compensation, work mode, and the decisions that always come back to you."],
  ["02", "Let the agent run", "It discovers direct roles, removes weak fits, checks duplicates, and applies with verified facts only."],
  ["03", "Review the record", "Every decision, application, pause, and outcome stays visible so the search improves instead of becoming noise."],
] as const;

/* Dateless build checklist. Facts from the repo only (README, ATTENTION.md, /platforms); no dates. */
const progress = [
  ["done", "Open-source agent released on npm and GitHub"],
  ["done", "Job board live at /jobs"],
  ["done", "Founding reservation open, with checkout by Dodo Payments"],
  ["done", "Optional private cloud state to keep one person’s application history together"],
  ["progress", "Hosted review flow: answer an employer’s question from a secure link"],
  ["next", "Scheduled job discovery"],
  ["next", "Persistent, resumable runs"],
  ["next", "Decision notifications"],
] as const;
const progressLabel = { done: "Done", progress: "In progress", next: "Next" } as const;

/*
 * Founder note: DRAFT copy in Vaibhav's voice, not yet approved. Off by default;
 * flip to true only after Vaibhav approves or rewrites the text below.
 */
const SHOW_FOUNDER_NOTE = false;

export default function Home() {
  return <>
    <SiteHeader />
    <main id="top">
      <header className="hero page-width">
        <div className="hero-copy">
          <h1>Find the role.<span>Let your agent apply.</span></h1>
          <p className="hero-summary">Start free: run the open-source agent and browse reviewed open roles. When you want it running for you, reserve Cloud.</p>
          <div className="hero-actions"><Link className="button" href="/#agent">Run the agent free</Link><Link className="button button-secondary" href="/jobs">Browse open roles</Link></div>
          <ul className="hero-proof"><li>Verified facts only</li><li>You set the boundaries</li><li>Every action recorded</li></ul>
        </div>
        <ol className="pillar-list" aria-label="Three steps">
          {path.map(item => <li key={item.id} className={`pillar pillar-${item.id}`}>
            <span className="pillar-step" aria-hidden="true">{item.step}</span>
            <div>
              <div className="pillar-head"><h2>{item.name}</h2><span className="pillar-tag">{item.tag}</span></div>
              <p>{item.body}</p>
              <Link className="text-link" href={item.href}>{item.cta} <span aria-hidden="true">→</span></Link>
            </div>
          </li>)}
        </ol>
      </header>

      {/* Renders nothing until every lifetime counter is available (no placeholder counts). */}
      <CommunityProof className="community-section page-width" />

      <section className="section page-width" id="free" aria-labelledby="free-title">
        <div className="section-heading"><p className="eyebrow">Available now · free</p><h2 id="free-title">Start with the free tools.</h2></div>
        <div className="free-grid">
          <article className="free-card" id="agent" aria-labelledby="agent-title">
            <p className="eyebrow">Open-source agent · MIT</p>
            <h3 id="agent-title">Run the agent on your own computer.</h3>
            <p>It finds direct roles, filters weak fits, submits truthful applications, pauses for real decisions, and keeps learning from outcomes.</p>
            <CopyCode code={INSTALL} />
            <p className="free-note">Needs Node.js 20 or newer and a coding agent that can drive a browser: Cursor, Claude Code, Codex, Copilot or Gemini. Guides for Hermes, Grok Bot and OpenClaw too.</p>
            <p className="install-links"><a href={REPO}>View on GitHub</a><Link href="/platforms">Setup guides</Link><Link href="/open-source">About the project</Link></p>
          </article>
          <article className="free-card" id="jobs" aria-labelledby="jobs-title">
            <p className="eyebrow">Job board</p>
            <h3 id="jobs-title">Open roles, reviewed and checked daily.</h3>
            <p>Maintainer-reviewed roles from the community registry. No account needed to browse.</p>
            <p>Filter roles, copy the ready-made prompt, and your agent applies.</p>
            <Link className="button" href="/jobs">Browse open roles</Link>
          </article>
        </div>
      </section>

      <section className="section page-width" id="process" aria-labelledby="process-title">
        <div className="section-heading"><h2 id="process-title">How it works</h2></div>
        <ol className="process-grid">{steps.map(([number, title, body]) => <li key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></li>)}</ol>
        <div className="boundary-columns" id="boundaries">
          <article><span>AGENT HANDLES</span><h3>Repeatable work</h3><ul><li>Discover and verify openings</li><li>Score evidence-backed fit</li><li>Deduplicate applications</li><li>Fill known profile facts</li><li>Maintain the application ledger</li></ul></article>
          <article className="human-card"><span>YOU HANDLE</span><h3>Real decisions</h3><ul><li>Authentication and CAPTCHA</li><li>Sponsorship ambiguity</li><li>Legal or demographic answers</li><li>Sensitive personal information</li><li>Anything outside your rules</li></ul></article>
        </div>
      </section>

      <section className="section page-width cloud-section" id="cloud" aria-label="Cloud founding reservation">
        <div className="founding-card" id="founding">
          <div><p className="eyebrow">Cloud · Coming soon</p><h2>Reserve founding access</h2><p>Pay $49 to lock the founding price. We email a confirmation. Cloud access opens later; no launch date is set.</p><p className="founding-limits">You stay in the loop. Some applications pause for a CAPTCHA or an employer question, and the agent waits for a quick step from you before it carries on.</p></div>
          <div className="offer-panel"><div><span>FOUNDING RESERVATION</span><strong>$49</strong></div><ul><li>Scheduled job discovery</li><li>Persistent, resumable runs</li><li>Decision notifications</li><li>Secure checkout by Dodo Payments</li></ul><FoundingCheckout /><p className="offer-terms">Reserves founding pricing for when Cloud launches. Not instant access. Not sure yet? <Link href="/#agent">Try the free agent first</Link>.</p></div>
        </div>
        <div className={`cloud-grid${SHOW_FOUNDER_NOTE ? "" : " cloud-grid-single"}`}>
          <div className="cloud-card">
            <div className="cloud-card-head"><h3>Cloud progress</h3><span className="launch-state"><i aria-hidden="true" />COMING SOON</span></div>
            <ul className="progress-list">{progress.map(([state, label]) => <li key={label} className={`progress-${state}`}><span className="progress-state">{progressLabel[state]}</span><span>{label}</span></li>)}</ul>
          </div>
          {/* DRAFT copy for Vaibhav to approve or rewrite before this ships. */}
          {SHOW_FOUNDER_NOTE ? <figure className="cloud-card founder-note">
            <h3>Why I’m taking money before Cloud exists</h3>
            <blockquote>
              <p>The open-source agent and the job board are free to use today. Cloud is different: a hosted agent costs money to run for every person on it.</p>
              <p>A $49 reservation is the clearest sign that you want it, and it helps pay for building it. If you’re not sure, run the free agent first and reserve when it earns it.</p>
            </blockquote>
            <figcaption>Vaibhav Arora, maker of JobAppAgent</figcaption>
          </figure> : null}
        </div>
      </section>

      <section className="section faq page-width">
        <div className="section-heading"><p className="eyebrow">Straight answers</p><h2>Before you start.</h2></div>
        <details><summary>Is the job board free?</summary><p>Yes. Browsing roles and copying a role’s prompt costs nothing and needs no account.</p></details>
        <details><summary>Do I need Cloud to use the agent?</summary><p>No. The open-source agent runs on your computer today under the MIT licence. Your coding agent’s subscription or model usage may cost extra.</p></details>
        <details><summary>When does Cloud launch?</summary><p>Cloud access is coming soon. $49 reserves founding pricing; we email when access opens.</p></details>
        <details><summary>Is it fully hands-off?</summary><p>Not completely. Some applications stop at a CAPTCHA or a question only you can answer. The agent pauses there until you take a quick step, then keeps going.</p></details>
        <details><summary>Is this a mass-application bot?</summary><p>No. It filters aggressively and applies only inside rules you set. Unclear or sensitive decisions pause for you.</p></details>
        <details><summary>What am I paying for?</summary><p>A founding-price reservation for cloud access when it launches. Not instant access.</p></details>
        <details><summary>How do I get access after paying?</summary><p>After payment we confirm your reservation by email. There is no instant self-serve dashboard yet.</p></details>
        <details><summary>Does it guarantee a job?</summary><p>No. It reduces repetitive search and application work. Employers make every hiring decision.</p></details>
      </section>
    </main>
    <SiteFooter />
  </>;
}
