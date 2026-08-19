import type { Metadata } from "next";
import { CommunityProof } from "./components/CommunityProof";
import { FoundingCheckout } from "./components/FoundingCheckout";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";

export const metadata: Metadata = {
  title: "A calmer way to job hunt.",
  description: "A disciplined job-search agent that discovers, qualifies, applies, pauses for judgment, and keeps a verified record while you are away.",
};

const steps = [
  ["01", "Set the boundaries", "Choose roles, locations, compensation, work mode, and the decisions that always come back to you."],
  ["02", "Let the agent run", "It discovers direct roles, removes weak fits, checks duplicates, and applies with verified facts only."],
  ["03", "Review the record", "Every decision, application, pause, and outcome stays visible so the search improves instead of becoming noise."],
] as const;

export default function Home() {
  return <>
    <SiteHeader />
    <main id="top">
      <header className="hero page-width">
        <div className="hero-copy">
          <p className="eyebrow">Launching September 18 · Pre-launch reservations open</p>
          <h1>A calmer way<span>to job hunt.</span></h1>
          <p className="hero-summary">JobAppAgent finds direct roles, filters weak fits, submits truthful applications, and pauses for the decisions only you should make. The routine keeps moving, without turning your search into noise.</p>
          <div className="hero-actions"><FoundingCheckout /><a className="button button-secondary" href="https://stats.jobappagent.com">See community activity</a></div>
          <ul className="hero-proof"><li>Verified facts only</li><li>You set the boundaries</li><li>90 days from activation</li></ul>
        </div>
        <CommunityProof />
      </header>

      <section className="section page-width" id="process">
        <div className="section-heading"><p className="eyebrow">How it works</p><h2>The search keeps moving, without becoming noise.</h2><p>The agent handles repetition without turning your career into a volume game.</p></div>
        <ol className="process-grid">{steps.map(([number, title, body]) => <li key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></li>)}</ol>
      </section>

      <section className="boundary-section" id="boundaries"><div className="page-width boundary-layout">
        <div><p className="eyebrow">Clear autonomy</p><h2>The agent carries the routine. You keep the judgment.</h2><p>The agent is useful because it knows where to stop.</p></div>
        <div className="boundary-columns">
          <article><span>AGENT HANDLES</span><h3>Repeatable work</h3><ul><li>Discover and verify openings</li><li>Score evidence-backed fit</li><li>Deduplicate applications</li><li>Fill known profile facts</li><li>Maintain the application ledger</li></ul></article>
          <article className="human-card"><span>YOU HANDLE</span><h3>Real decisions</h3><ul><li>Authentication and CAPTCHA</li><li>Sponsorship ambiguity</li><li>Legal or demographic answers</li><li>Sensitive personal information</li><li>Anything outside your rules</li></ul></article>
        </div>
      </div></section>

      <section className="section page-width" id="founding">
        <div className="founding-card">
          <div><p className="eyebrow">Pre-launch offer</p><h2>Reserve the launch price.</h2><p>JobAppAgent launches September 18, 2026. Pay $49 globally or ₹3,999 including GST in India now. Your 90 days begin only when access is activated. If we have not activated you within 60 days of payment, you will be automatically refunded.</p></div>
          <div className="offer-panel"><div><span>PRE-LAUNCH PRICE</span><strong>$49</strong><small>₹3,999 incl. GST in India · launches September 18</small></div><ul><li>90 days from activation</li><li>Scheduled job discovery</li><li>Persistent, resumable runs</li><li>Decision notifications</li><li>Secure checkout by Dodo Payments</li></ul><FoundingCheckout /></div>
        </div>
      </section>

      <section className="section faq page-width">
        <div className="section-heading"><p className="eyebrow">Straight answers</p><h2>Before you reserve.</h2></div>
        <details><summary>Is this a mass-application bot?</summary><p>No. It filters aggressively and applies only inside rules you set. Unclear or sensitive decisions pause for you.</p></details>
        <details><summary>When does JobAppAgent launch?</summary><p>The cloud product is scheduled to launch on September 18, 2026. This offer reserves access at the pre-launch price.</p></details>
        <details><summary>When do my 90 days begin?</summary><p>On the day your cloud access is activated—not on the payment date.</p></details>
        <details><summary>What if access is not ready?</summary><p>If we have not activated your access within 60 days of payment, your full payment is automatically refunded.</p></details>
        <details><summary>Does it guarantee a job?</summary><p>No. It reduces repetitive search and application work. Employers make every hiring decision.</p></details>
      </section>
    </main>
    <SiteFooter />
  </>;
}
