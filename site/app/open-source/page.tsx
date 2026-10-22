import type { Metadata } from "next";
import Link from "next/link";
import { JsonLd } from "../components/JsonLd";
import { CopyCode } from "../components/CopyCode";
import { OpenSourceStats } from "../components/OpenSourceStats";
import { breadcrumbListJsonLd, openSourceSoftwareJsonLd } from "../../lib/structured-data.mjs";
import styles from "../components/ContentPage.module.css";

const TITLE = "JobAppAgent: the open-source job application agent";
const DESCRIPTION = "JobAppAgent is an open-source job application agent (MIT). It applies from one verified résumé within your rules. By default you approve each submit.";
const URL = "https://jobappagent.com/open-source";
const REPO = "https://github.com/vaibhavarora14/job-application-agent";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { title: TITLE, description: DESCRIPTION, url: URL, type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "JobAppAgent, the open-source job application agent" }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function OpenSource() {
  const breadcrumbs = breadcrumbListJsonLd([
    { name: "Home", path: "/" },
    { name: "Open source", path: "/open-source" },
  ]);
  return <main className={`legal page-width ${styles.page}`}>
    <JsonLd data={openSourceSoftwareJsonLd()} />
    <JsonLd data={breadcrumbs} />
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>JobAppAgent, the <span className={styles.nb}>open‑source</span> job application agent</h1>
    <p>JobAppAgent is an open-source job application agent for people applying to jobs for themselves. It runs inside a browser-capable coding agent on your computer. It searches for roles, checks each one against your verified résumé and preferences, fills in the applications that pass, and keeps a record of everything. A job counts as applied only after the site shows a confirmation.</p>
    <p>JobAppAgent, the GitHub repo <code>vaibhavarora14/job-application-agent</code> and the npm package <code>job-application-agent</code> are the same project. It is MIT licensed.</p>
    <p className={styles.smallPrint}>JobAppAgent isn&apos;t affiliated with other GitHub repositories that use the name &quot;job-application-agent&quot;.</p>

    <OpenSourceStats className={styles.stats} />

    <h2>What it does</h2>
    <p><strong>Search.</strong> It finds open roles from a reviewed list of sources plus a community registry of public job links, and resolves them to the employer&apos;s own careers page or job system where possible.</p>
    <p><strong>Match.</strong> Each role is checked against one verified résumé and the preferences you set: role, location, pay floor, work mode, sponsorship. It scores fit and checks for duplicates. Weak fits are skipped. The thresholds don&apos;t drop to hit a number.</p>
    <p><strong>Apply within your rules.</strong> By default you review every application before it goes out, one job at a time (<code>review-each</code>). If you want, you can turn on <code>routine-auto</code> for a destination or batch you&apos;ve authorised. It then submits routine applications on its own, and still hands sensitive or judgment calls back to you. You can check or revoke that grant at any time.</p>
    <p><strong>Track.</strong> Applications go into a ledger on your machine, and only visibly confirmed submissions get recorded as applied. A filled form isn&apos;t an application. You can log outcomes later and use them to adjust your targeting.</p>
    <p>It always stops and asks you about:</p>
    <ul>
      <li>sign-in, SSO, MFA and CAPTCHA</li>
      <li>legal attestations and government ID questions</li>
      <li>demographic or voluntary self-identification questions</li>
      <li>unclear work authorisation, sponsorship, location or pay</li>
      <li>any claim it can&apos;t verify from your profile or résumé</li>
    </ul>

    <h2>Install</h2>
    <p>You need Node.js 20 or newer and a coding agent that can drive a browser.</p>
    <CopyCode code="npx job-application-agent@latest install" />
    <p>That installs the full skill. It tells you when a new version is out and installs nothing until you ask. To opt in to automatic updates, run <code>npx job-application-agent@latest updates enable</code>.</p>
    <p>If you&apos;d rather use the skills CLI:</p>
    <CopyCode code="npx skills add vaibhavarora14/job-application-agent" />
    <p>Check the install:</p>
    <CopyCode code="npx job-application-agent@latest status" />
    <p>Then ask your agent: &quot;Use job-application-agent to onboard my résumé and job preferences.&quot;</p>

    <h2>Source code and licence</h2>
    <ul>
      <li>Repository: <a href={REPO}>{REPO}</a></li>
      <li>Licence: MIT. You can use it, change it and redistribute it.</li>
      <li>npm package: <a href="https://www.npmjs.com/package/job-application-agent"><code>job-application-agent</code></a></li>
    </ul>

    <h2>Privacy, in brief</h2>
    <p>Your profile facts go in your operating system&apos;s credential store (macOS Keychain, Windows Credential Manager or Linux Secret Service). Your résumé and application ledgers stay in an owner-only folder on your computer. It never stores passwords, MFA codes, government IDs, demographic data, CAPTCHA answers or browser session data, and it never reads browser cookies.</p>
    <p>Three things are on by default, and each one can be switched off from the CLI:</p>
    <ul>
      <li>Usage analytics, tied to an anonymous install ID. Events never include your name, email, phone, résumé, prompts or answers. Turn off with <code>telemetry disable</code>.</li>
      <li>A private contact record with the name and email saved in your profile, used for support and product updates. Turn off with <code>telemetry contact disable</code>.</li>
      <li>Anonymous community sharing of the public job links you&apos;ve applied to (job URL, company, role and channel, never anything about you). Turn off with <code>sources sharing disable</code>.</li>
    </ul>
    <p>Details: <Link href="/privacy">Privacy policy</Link>.</p>

    <h2>Contribute or report a problem</h2>
    <ul>
      <li>Report bugs or ask for features in <a href={`${REPO}/issues`}>GitHub issues</a>.</li>
      <li>For support contacts, see <a href={`${REPO}/blob/main/plugins/job-application-agent/SUPPORT.md`}>SUPPORT.md</a>.</li>
      <li>Report security problems privately through a <a href={`${REPO}/security/advisories/new`}>GitHub security advisory</a>, not in a public issue.</li>
      <li>Pull requests are welcome. Keep each one to a single change and run the checks in <a href={`${REPO}/blob/main/CONTRIBUTING.md`}>CONTRIBUTING.md</a> first.</li>
    </ul>

    <h2>FAQ</h2>
    <div className={`faq ${styles.faq}`}>
      <details><summary>What is JobAppAgent?</summary><p>JobAppAgent is an open-source job application agent, MIT licensed, published as <code>vaibhavarora14/job-application-agent</code> on GitHub and <code>job-application-agent</code> on npm. It runs inside a coding agent on your computer. It searches for roles, matches them to one verified résumé and your preferences, applies within rules you set, and records an application only after a visible confirmation.</p></details>
      <details><summary>Does JobAppAgent submit applications without asking me?</summary><p>Not by default. JobAppAgent starts in <code>review-each</code> mode, so you approve every application before it goes out. You can turn on <code>routine-auto</code> for destinations or batches you&apos;ve authorised. Even then it pauses for sign-in, CAPTCHA, legal and demographic questions, and anything it can&apos;t verify. The confirmation prompts in your browser and agent still apply in either mode.</p></details>
      <details><summary>How do I install JobAppAgent?</summary><p>Run <code>npx job-application-agent@latest install</code> with Node.js 20 or newer, then check it with <code>npx job-application-agent@latest status</code>. You can also install it with the skills CLI: <code>npx skills add vaibhavarora14/job-application-agent</code>.</p></details>
      <details><summary>Where does JobAppAgent keep my data?</summary><p>Profile facts stay in your OS credential store, and your résumé and application ledgers stay in an owner-only folder on your computer. Anonymous usage analytics, a private contact record (your saved name and email) and community sharing of public job links are on by default. You can turn each one off with a CLI command.</p></details>
      <details><summary>Is JobAppAgent the same as other &quot;job-application-agent&quot; repositories on GitHub?</summary><p>No. JobAppAgent is <code>vaibhavarora14/job-application-agent</code>, the project behind jobappagent.com and the <code>job-application-agent</code> npm package. Other repositories with the same name are separate projects.</p></details>
    </div>

    <section className={styles.crossLinks} aria-label="Install and links">
      <h2>Install in one line</h2>
      <CopyCode code="npx job-application-agent@latest install" />
      <p><a href={REPO}>View on GitHub</a> · <Link href="/compare">See how it compares</Link></p>
    </section>
  </main>;
}
