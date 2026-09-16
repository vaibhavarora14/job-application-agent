import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import catalog from "../../../../job-application-agent/platforms.json";
import styles from "../platforms.module.css";

type Props = { params: Promise<{ platform: string }> };
function findPlatform(id: string) {
  return catalog.platforms.find(platform => platform.id === id);
}
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const platform = findPlatform((await params).platform);
  return platform ? { title: `Job Application Agent for ${platform.name}`, description: platform.description,
    alternates: { canonical: `https://jobappagent.com/platforms/${platform.id}` } } : {};
}

export default async function PlatformGuide({ params }: Props) {
  const platform = findPlatform((await params).platform);
  if (!platform) notFound();
  const prompt = `${platform.starter}\n\n${catalog.instructions}`;
  return <main className={`legal page-width ${styles.guide}`}>
    <Link className="legal-back" href="/platforms">← All agent setup guides</Link>
    <p className="eyebrow">{platform.name}</p>
    <h1>A calmer job search, in {platform.name}.</h1>
    <p>{platform.description}</p><p className={styles.status}>{platform.status}</p>
    <p>This is a setup template for your own account. Full application support depends on the browser and secure storage available on your agent’s computer.</p>
    {platform.steps.map((step, i) => <section key={step.title}>
      <h2>{i + 1}. {step.title}</h2><p>{step.text}</p>
      {"code" in step && <pre className={styles.code}><code>{step.code}</code></pre>}
    </section>)}
    <h2>4. Give your agent the setup prompt</h2>
    <p>Copy this into a private conversation with your agent. It starts with prerequisites and review mode; it does not authorize applications or turn on recurring runs.</p>
    <label className={styles.promptLabel} htmlFor="setup-prompt">Reusable setup prompt</label>
    <textarea className={styles.prompt} id="setup-prompt" readOnly value={prompt} rows={12} spellCheck={false} />
    <h2>Verify before your first application</h2>
    <p>Check that your agent can load the complete skill, keep your profile private, upload a synthetic PDF on a local test page, and hand the browser back to you. Then review one real application. Only visible confirmation counts as submitted.</p>
    <p><a href={platform.docsUrl}>Read the official {platform.name} documentation</a> · <a href="https://github.com/vaibhavarora14/job-application-agent">Inspect the open-source project</a></p>
  </main>;
}
