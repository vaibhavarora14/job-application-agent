import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { JsonLd } from "../components/JsonLd";
import { breadcrumbListJsonLd } from "../../lib/structured-data.mjs";
import styles from "../components/ContentPage.module.css";

const TITLE = "Open-source job application agents compared | JobAppAgent";
const DESCRIPTION = "How JobAppAgent, an open-source job application agent, compares with ApplyPilot, career-ops, LangHire and others on automation, ATS support, approval.";
const URL = "https://jobappagent.com/compare";

export const metadata: Metadata = {
  title: { absolute: TITLE },
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { title: TITLE, description: DESCRIPTION, url: URL, type: "website", images: [{ url: "/og.png", width: 1200, height: 630, alt: "How JobAppAgent compares to other open-source job application agents" }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

/** Public sources for the table, numbered as in the reviewed copy. */
const SOURCES: Record<number, string> = {
  1: "https://github.com/vaibhavarora14/job-application-agent",
  2: "https://github.com/torontodeveloper/job-application-agent",
  3: "https://github.com/Yaima/agent-apply",
  4: "https://github.com/Pickle-Pixel/ApplyPilot",
  5: "https://github.com/career-ops-hq/career-ops",
  6: "https://github.com/career-ops-hq/career-ops/blob/main/docs/APPLY_AUTOFILL.md",
  7: "https://github.com/jaimaann/LangHire",
  8: "https://github.com/zeyadelganainy/job-agent-autopilot",
  9: "https://zeyad.ca/projects/job-agent",
  10: "https://github.com/suxrobGM/jobpilot",
  11: "https://github.com/suxrobGM/jobpilot/blob/main/docs/architecture.md",
};

/** Renders `code` spans from the copy deck as <code>. */
function md(text: string): ReactNode {
  return text.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part);
}

/** standalone: the label replaces the "Approval before submit:" prefix. */
type Approval = { tone: "yes" | "no" | "neutral"; label: string; standalone?: boolean };
type Row = { name: string; repo?: string; refs: number[]; approval: Approval; cells: [string, string, string, string, string, string] };

const ROWS: Row[] = [
  { name: "JobAppAgent", approval: { tone: "yes", label: "yes, by default" }, repo: "vaibhavarora14/job-application-agent", refs: [1], cells: [
    "Searches, matches, fills and submits. `review-each` is the default. Optional `routine-auto` submits routine applications in batches you've authorised, and pauses for sensitive steps.",
    "Uses the browser your coding agent provides. Submits to Greenhouse, Ashby and Lever, which test fixtures cover. Other documented channels: LinkedIn, Workable, Comeet, Rippling, SmartRecruiters, Google Forms, company career sites and email. Workday is listed but not yet submitted to or tested. It won't automate LinkedIn or X sign-in or messaging.",
    "Yes by default (`review-each`). Optional `routine-auto`.",
    "MIT",
    "`npx job-application-agent@latest install` or `npx skills add`",
    "Profile in the OS credential store. Résumé and ledgers in a local owner-only folder (an optional private remote store can be configured). Analytics, contact record and community sharing are on by default, with opt-outs.",
  ] },
  { name: "torontodeveloper/job-application-agent", approval: { tone: "neutral", label: "Never submits: you click Submit", standalone: true }, refs: [2], cells: [
    "Discovers roles, tailors the résumé, fills the form, then stops for you to submit.",
    "Greenhouse, Ashby, Lever (\"...\"). Workday after you log in once. README says not to use it on LinkedIn Easy Apply.",
    "Never submits: you click Submit. \"It never submits on its own.\"",
    "Not stated (no licence file in the repo)",
    "Python venv, `pip install -r requirements.txt`, Playwright",
    "Local files (`profile.yaml`, a persistent browser profile), kept out of git",
  ] },
  { name: "agent-apply", approval: { tone: "yes", label: "yes" }, repo: "Yaima/agent-apply", refs: [3], cells: [
    "Reads a tracker spreadsheet, checks postings are live, fills applications. Dry run by default. Live mode pauses before each submit.",
    "Greenhouse and Lever: filled, you submit. Ashby: filled, then you apply by hand. Workday, Google and Apple careers: assisted. LinkedIn: by hand only.",
    "Yes. \"There is no fully-automated submit path, by design.\"",
    "MIT",
    "`pip install -r requirements.txt` plus Playwright",
    "Local: `profile.yaml`, `.xlsx` tracker, logs, all kept out of git",
  ] },
  { name: "ApplyPilot", approval: { tone: "no", label: "no, by default" }, repo: "Pickle-Pixel/ApplyPilot", refs: [4], cells: [
    "Fully autonomous six-stage pipeline that discovers, scores, tailors, writes cover letters and submits.",
    "Indeed, LinkedIn, Glassdoor, ZipRecruiter, Google Jobs, 48 Workday employer portals and 30 direct career sites (README figures vary: 46/48 and 28/30). Greenhouse, Lever and Ashby: not stated.",
    "No by default. `--dry-run` fills forms without submitting.",
    "AGPL-3.0",
    "`pip install applypilot`; auto-apply also needs the Claude Code CLI and Chrome",
    "Local config files (`profile.json`, `searches.yaml`, `.env`). Otherwise not stated.",
  ] },
  { name: "career-ops", approval: { tone: "neutral", label: "Never submits: you click Submit", standalone: true }, repo: "career-ops-hq/career-ops", refs: [5, 6], cells: [
    "Evaluates and scores roles, tailors the CV, drafts answers and fills forms. Never submits.",
    "Autofill field-tested on Ashby, Greenhouse, Lever and Workable. Portal scanner covers Ashby, Greenhouse, Lever and Wellfound. Workday and LinkedIn Easy Apply: not stated.",
    "Never submits: you click Submit. \"The system never submits an application.\"",
    "MIT",
    "`npx @santifer/career-ops init`, run in an AI coding CLI",
    "Local project folder (or a data directory you choose)",
  ] },
  { name: "LangHire", approval: { tone: "neutral", label: "not stated" }, repo: "jaimaann/LangHire", refs: [7], cells: [
    "Desktop app whose browser agent collects jobs, fills forms, answers screening questions and submits. Parallel workers.",
    "LinkedIn Easy Apply and external ATS. Lists 30+ ATS including Workday, Greenhouse, Lever, iCIMS, SmartRecruiters and Taleo. Ashby: not stated.",
    "Not stated. The README describes the agent filling and submitting.",
    "MIT",
    "Desktop installers (macOS, Windows, Linux)",
    "\"100% local\", in the OS app data folder",
  ] },
  { name: "JobPilot by Zeyad Elganainy", approval: { tone: "neutral", label: "Never submits: you apply yourself", standalone: true }, repo: "zeyadelganainy/job-agent-autopilot", refs: [8, 9], cells: [
    "Self-hosted daily run that scans feeds, scores roles and writes a tailored résumé and cover letter. It never fills or submits applications.",
    "Reads Greenhouse, Lever and Ashby public feeds. Workday, Taleo and iCIMS postings go to a manual triage queue.",
    "Never submits: you apply yourself. \"A human always submits.\"",
    "MIT",
    "`pip install -r requirements.txt` on your own machine or server",
    "Your own machine or server. Keys and profile kept out of git.",
  ] },
  { name: "JobPilot by suxrobGM", approval: { tone: "neutral", label: "optional, depends on mode" }, repo: "suxrobGM/jobpilot", refs: [10, 11], cells: [
    "Searches boards, scores jobs and applies. Search-only mode waits for your approval. Auto-apply works up to a limit. \"Pilot\" can run the whole search.",
    "Boards: LinkedIn, Indeed, Hiring Cafe and others. ATS (Greenhouse, Lever, Ashby, Workday): not stated. LinkedIn Easy Apply: not stated.",
    "Optional. It depends on the mode (Search only vs Auto-apply / Pilot).",
    "MIT",
    "Claude Code or Codex plugin from the author's own marketplace, plus a terminal host",
    "Profile, résumés and applications in your JobPilot account. Browser sessions stay on your computer.",
  ] },
];

const TAG_CLASS = { yes: styles.tagYes, no: styles.tagNo, neutral: styles.tagNeutral } as const;
/** Card label → cell index (approval is shown as the tag). */
const CARD_FIELDS = [["Does", 0], ["Job sites", 1], ["Licence", 3], ["Install", 4], ["Data", 5]] as const;

const HEADERS = ["Automation level", "ATS / site coverage (as documented)", "Approval before submit", "Licence", "Install", "Where data lives"];

export default function Compare() {
  const breadcrumbs = breadcrumbListJsonLd([
    { name: "Home", path: "/" },
    { name: "Compare", path: "/compare" },
  ]);
  return <main className={`legal page-width ${styles.page} ${styles.wide}`}>
    <JsonLd data={breadcrumbs} />
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>How JobAppAgent compares to other <span className={styles.nb}>open‑source</span> job agents</h1>
    <p>JobAppAgent is an open-source job application agent, and it isn&apos;t the only one. Several open-source projects now find roles, fill in forms and track applications. They differ in how much they do without asking, which job systems they handle, and where your data ends up. The table below compares them on those points, using only what each project says in its own README or docs. Where a project doesn&apos;t say, the cell says &quot;not stated&quot;.</p>
    <p className={styles.smallPrint}><em>Last checked 22 Oct 2026. Projects change quickly, so check the linked source before you rely on a cell.</em></p>

    <h2>Comparison table</h2>
    <p>Key: &quot;Approval before submit&quot; means a person approves each application before it&apos;s sent.</p>
    <div className={styles.tableWrap} role="region" aria-label="Comparison of open-source job application agents">
      <table className={styles.table}>
        <thead><tr><th scope="col">Project</th>{HEADERS.map(header => <th scope="col" key={header}>{header}</th>)}</tr></thead>
        <tbody>
          {ROWS.map(row => <tr key={row.name}>
            <th scope="row">
              <strong>{row.name}</strong>{row.repo ? <> (<code>{row.repo}</code>)</> : null}{" "}
              {row.refs.map(ref => <sup key={ref}><a href={SOURCES[ref]} rel="noopener">[{ref}]</a></sup>)}
            </th>
            {row.cells.map((cell, index) => <td key={index}>{md(cell)}</td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
    <ul className={styles.cards} aria-label="Comparison of open-source job application agents">
      {ROWS.map(row => <li className={styles.card} key={row.name}>
        <h3>{row.name}</h3>
        <div className={styles.repo}>
          {row.repo ?? null}{" "}
          {row.refs.map(ref => <a key={ref} href={SOURCES[ref]} rel="noopener">[{ref}]</a>)}
        </div>
        <span className={`${styles.tag} ${TAG_CLASS[row.approval.tone]}`}>{row.approval.standalone ? row.approval.label : `Approval before submit: ${row.approval.label}`}</span>
        <dl>
          {CARD_FIELDS.map(([label, index]) => <div key={label}><dt>{label}</dt><dd>{md(row.cells[index])}</dd></div>)}
        </dl>
      </li>)}
    </ul>

    <h2>How to choose</h2>
    <ul className={styles.choose}>
      <li><strong>You want a person to approve every submit and you&apos;re comfortable in a coding agent.</strong> JobAppAgent, career-ops and agent-apply all keep you on the submit button. JobAppAgent also checks eligibility and duplicates, and only counts confirmed submissions. career-ops has the larger scanner and the CV and cover-letter tooling. agent-apply suits a spreadsheet tracker.</li>
      <li><strong>You want the most hands-off pipeline.</strong> ApplyPilot is built to submit on its own across many boards and Workday portals. LangHire does the same from a desktop app. Both fit that need better than JobAppAgent, which defaults to review.</li>
      <li><strong>You want documents prepared, and you apply yourself.</strong> Zeyad Elganainy&apos;s JobPilot never submits. It sends a daily digest with tailored documents.</li>
      <li><strong>You want a desktop app rather than a coding agent.</strong> LangHire ships installers for macOS, Windows and Linux.</li>
      <li><strong>You want a hosted dashboard and outreach in one place.</strong> suxrobGM&apos;s JobPilot keeps your data in a JobPilot account and includes recruiter outreach.</li>
      <li><strong>You want everything on your machine with nothing sent anywhere.</strong> Check each project&apos;s analytics settings. JobAppAgent keeps your profile and résumé local, but its usage analytics, contact record and community sharing are on until you turn them off.</li>
    </ul>

    <h2>Not in the table</h2>
    <p>AI answers also mention &quot;AIJobAgent&quot; and &quot;AutoApply&quot;. We couldn&apos;t match either name to one specific project, so they&apos;re left out rather than guessed. The repository <code>feder-cr/Jobs_Applier_AI_Agent_AIHawk</code> now redirects to a different project.</p>

    <h2>Sources</h2>
    <ol>
      {Object.entries(SOURCES).map(([ref, href]) => <li key={ref} value={Number(ref)}><a href={href} rel="noopener">{href.replace(/^https:\/\//, "")}</a></li>)}
    </ol>
    <p className={styles.crossLinks}><Link href="/open-source">About the project</Link> · <a href="https://github.com/vaibhavarora14/job-application-agent">View on GitHub</a></p>
  </main>;
}
