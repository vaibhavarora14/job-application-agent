import type { Metadata } from "next";
import { CommunityProof } from "./components/CommunityProof";
import { FoundingCheckout } from "./components/FoundingCheckout";
import { LaunchCountdown } from "./components/LaunchCountdown";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";

export const metadata: Metadata = {
  title: "Set the goal. Keep the search moving.",
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
          <p className="eyebrow">Founding hosted open · $49</p>
          <h1>Set the goal.<span>Keep the search moving.</span></h1>
          <p className="hero-summary">Job Application Agent finds direct roles, filters weak fits, submits truthful applications, pauses for real decisions, and keeps learning from outcomes—even while you are away.</p>
          <div className="hero-actions"><FoundingCheckout /><a className="button button-secondary" href="https://stats.jobappagent.com">See community momentum</a></div>
          <ul className="hero-proof"><li>Verified facts only</li><li>You set the boundaries</li><li>Every action recorded</li></ul>
        </div>
        <LaunchCountdown />
      </header>

      <section className="community-section page-width" aria-label="Community momentum"><CommunityProof /></section>

      <section className="section page-width" id="process">
        <div className="section-heading"><p className="eyebrow">How it works</p><h2>One clear loop. No application theatre.</h2><p>The agent handles repetition without turning your career into a volume game.</p></div>
        <ol className="process-grid">{steps.map(([number, title, body]) => <li key={number}><span>{number}</span><h3>{title}</h3><p>{body}</p></li>)}</ol>
      </section>

      <section className="boundary-section" id="boundaries"><div className="page-width boundary-layout">
        <div><p className="eyebrow">Clear autonomy</p><h2>Routine work keeps moving. Judgment stays yours.</h2><p>The agent is useful because it knows where to stop.</p></div>
        <div className="boundary-columns">
          <article><span>AGENT HANDLES</span><h3>Repeatable work</h3><ul><li>Discover and verify openings</li><li>Score evidence-backed fit</li><li>Deduplicate applications</li><li>Fill known profile facts</li><li>Maintain the application ledger</li></ul></article>
          <article className="human-card"><span>YOU HANDLE</span><h3>Real decisions</h3><ul><li>Authentication and CAPTCHA</li><li>Sponsorship ambiguity</li><li>Legal or demographic answers</li><li>Sensitive personal information</li><li>Anything outside your rules</li></ul></article>
        </div>
      </div></section>

      <section className="section page-width" id="founding">
        <div className="founding-card">
          <div><p className="eyebrow">Founding hosted access</p><h2>Activate the agent that keeps running.</h2><p>Hosted continuity is open for founding members. Pay $49 to unlock activatable hosted access at the founding price. After payment, we email access details to the address collected at checkout. Cloud access remains coming soon.</p></div>
          <div className="offer-panel"><div><span>FOUNDING PRICE</span><strong>$49</strong><small>90 days of hosted access · starts when we activate your seat</small></div><ul><li>Scheduled job discovery</li><li>Persistent, resumable runs</li><li>Decision notifications</li><li>Secure checkout by Dodo Payments</li></ul><FoundingCheckout /></div>
        </div>
      </section>

      <section className="section faq page-width">
        <div className="section-heading"><p className="eyebrow">Straight answers</p><h2>Before you activate.</h2></div>
        <details><summary>When does Job Application Agent launch?</summary><p>Hosted continuity is open for founding members now. Cloud access is still coming soon. After founding payment, we email hosted access details.</p></details>
        <details><summary>Is this a mass-application bot?</summary><p>No. It filters aggressively and applies only inside rules you set. Unclear or sensitive decisions pause for you.</p></details>
        <details><summary>When do my 90 days begin?</summary><p>When we activate your hosted seat and email access details — not on the payment date alone.</p></details>
        <details><summary>How do I get access after paying?</summary><p>Checkout collects your email. After payment is verified, we email founding hosted access details. There is no instant self-serve dashboard yet.</p></details>
        <details><summary>Does it guarantee a job?</summary><p>No. It reduces repetitive search and application work. Employers make every hiring decision.</p></details>
      </section>
    </main>
    <SiteFooter />
  </>;
}
