import type { Metadata } from "next";
import Link from "next/link";
import catalog from "../../../job-application-agent/platforms.json";
import styles from "./platforms.module.css";

export const metadata: Metadata = {
  title: "Choose your agent",
  description: "Set up Job Application Agent in Hermes, Grok Bot, or OpenClaw with your own résumé and preferences.",
  alternates: { canonical: "https://jobappagent.com/platforms" },
};

export default function Platforms() {
  return <main className={`legal page-width ${styles.guide}`}>
    <Link className="legal-back" href="/">← Back to the product</Link>
    <p className="eyebrow">Open-source agent · setup guides</p>
    <h1>Your job search.<br />Your choice of agent.</h1>
    <p>One verified résumé, clear preferences, and a record of confirmed applications. Bring the workflow into the agent you already use.</p>
    <p>These guides use your own agent account and computer. They do not activate JobAppAgent hosted continuity. Platform subscriptions and model usage may cost extra.</p>
    <div className={styles.platforms}>
      {catalog.platforms.map(platform => <section key={platform.id}>
        <h2><Link href={`/platforms/${platform.id}`}>{platform.name} <span aria-hidden="true">↗</span></Link></h2>
        <p>{platform.description}</p><p className={styles.status}>{platform.status}</p>
      </section>)}
    </div>
    <h2>Already using a coding agent?</h2>
    <p>The managed installer also supports existing Codex, Claude Code, Cursor, Copilot, and Gemini skill directories. Each host still needs compatible browser tools. <a href="https://github.com/vaibhavarora14/job-application-agent#-get-started">Read the setup guide</a>.</p>
    <h2>Keep your application history together</h2>
    <p>Optional private cloud state connects one person’s trusted hosts. It coordinates submissions so two agents do not apply to the same role. Each candidate needs their own private state and credentials.</p>
  </main>;
}
