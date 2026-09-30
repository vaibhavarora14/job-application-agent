import type { Metadata } from "next";
import Link from "next/link";
import { attentionEnv } from "../../../lib/attention-auth";
import { actionLabel, blockerLabel } from "../../../lib/attention-action-labels.mjs";
import { resolveAttentionDesignFixture } from "../../../lib/attention-design-fixtures.mjs";
import { buildLiveSessionProxyPath } from "../../../lib/attention-live-session.mjs";
import { verifyAttentionMagicLink } from "../../../lib/attention-magic-link.mjs";
import { BLOCKER_COPY } from "../../../lib/attention-mail.mjs";
import { hasJudgmentActions, needsLiveBrowser } from "../../../lib/attention-questions.mjs";
import { AttentionActions } from "./AttentionActions";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string; design?: string }>;
};

type MagicPayload = {
  attentionId: string;
  company: string;
  role: string;
  url: string;
  stage: string;
  blocker: string;
  requiredActions: string[];
  questions: { id: string; prompt: string; kind: string; required: boolean }[];
  aiAssistanceDiscouraged: boolean;
  expiresAt: number;
};

type VerifyOk = { ok: true; payload: MagicPayload };
type VerifyErr = { ok: false; error: string };

export const metadata: Metadata = {
  title: "Attention",
  robots: { index: false, follow: false },
};

export default async function AttentionPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const attentionId = decodeURIComponent(id ?? "").trim();
  const query = await searchParams;
  const { token: rawToken } = query;
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  const config = attentionEnv();

  // Design harness: known ?design= keys only (mirrors checkout ?design=success).
  // Invalid/missing design does not bypass the magic-link token gate.
  const designFixture = resolveAttentionDesignFixture(query);
  if (designFixture) {
    return (
      <AttentionShell>
        <AttentionFixtureBody fixture={designFixture} />
      </AttentionShell>
    );
  }

  if (!token) {
    return <AttentionShell>
      <AttentionError
        title="This link needs a secure token."
        body="Open the signed link from your Hosted attention email to continue this pause. If the message is missing, ask the run to send a fresh notify."
      />
    </AttentionShell>;
  }

  const verified = await verifyAttentionMagicLink(token, config.magicLinkSecret, { attentionId }) as VerifyOk | VerifyErr;
  if (!verified.ok) {
    return <AttentionShell>
      <AttentionError
        title={verified.error === "token_expired" ? "This link has expired." : "This attention link is not valid."}
        body="Open the newest Hosted attention email for a fresh signed link, or ask the run to send another notify. Links usually last under an hour."
      />
    </AttentionShell>;
  }

  const view = verified.payload;
  const why = (BLOCKER_COPY as Record<string, string>)[view.blocker] ?? BLOCKER_COPY.other;
  const liveSessionAvailable = Boolean(String(config.liveSessionBaseUrl ?? "").trim());
  const liveSessionUrl = buildLiveSessionProxyPath(view.attentionId, token);
  const liveSessionEmbedUrl = buildLiveSessionProxyPath(view.attentionId, token, { embed: true });
  const liveNeeded = needsLiveBrowser(view.requiredActions);
  const packagedQuestions = Array.isArray(view.questions) ? view.questions : [];
  const questions = packagedQuestions.length
    ? packagedQuestions
    : (view.requiredActions.includes("provide-judgment")
      ? [{
        id: "judgment-default",
        prompt: "Share your judgment answer for this application (why this role / proud project).",
        kind: "judgment",
        required: true,
      }]
      : []);
  const judgmentUi = hasJudgmentActions(view.requiredActions) || questions.length > 0;

  return (
    <AttentionShell>
      <AttentionCard
        view={{
          attentionId: view.attentionId,
          company: view.company,
          role: view.role,
          url: view.url,
          stage: view.stage,
          blocker: view.blocker,
          requiredActions: view.requiredActions,
          questions,
          aiAssistanceDiscouraged: Boolean(view.aiAssistanceDiscouraged),
          why,
          liveSessionUrl,
          liveSessionEmbedUrl,
          liveSessionAvailable,
          token,
          expiresAt: view.expiresAt,
        }}
        liveNeeded={liveNeeded}
        judgmentUi={judgmentUi}
      />
    </AttentionShell>
  );
}

function AttentionFixtureBody({
  fixture,
}: {
  fixture: NonNullable<ReturnType<typeof resolveAttentionDesignFixture>>;
}) {
  const { view, key, ui } = fixture;
  const liveNeeded = needsLiveBrowser(view.requiredActions);
  const judgmentUi = hasJudgmentActions(view.requiredActions) || view.questions.length > 0;

  return (
    <>
      <header className="attention-header" data-design-fixture={key}>
        <p className="eyebrow">Design preview</p>
        <h1>{view.role || "Paused application"}</h1>
        <p className="attention-summary">
          {view.company ? <>at <strong>{view.company}</strong>. </> : null}
          {view.why}
        </p>
        <div className="attention-meta">
          <span className="attention-chip">{blockerLabel(view.blocker)}</span>
          {view.aiAssistanceDiscouraged ? (
            <span className="attention-meta-item">Own voice</span>
          ) : null}
        </div>
        <p className="attention-fixture-note">
          Design fixture only — no magic-link, signal, wake, or live session.
        </p>
      </header>

      <section className="attention-panel" aria-labelledby="required-actions-heading">
        <h2 id="required-actions-heading">What needs you</h2>
        <ul className="attention-checklist">
          {(view.requiredActions.length ? view.requiredActions : ["open-live-session"]).map((action) => (
            <li key={action}>{action === "open-live-session" ? "Open the live browser and finish the paused step" : actionLabel(action)}</li>
          ))}
        </ul>
        {view.url ? (
          <p className="attention-url">
            Application page:{" "}
            <a href={view.url} target="_blank" rel="noreferrer">{view.url}</a>
          </p>
        ) : null}
      </section>

      <section className="attention-panel attention-act-panel" aria-labelledby="act-heading">
        <h2 id="act-heading">{judgmentUi ? "Answer & resume" : "Act in the live browser"}</h2>
        <p>
          {judgmentUi
            ? "Judgment answers stay on this card and are used when you resume. Use the live browser for CAPTCHA, MFA, or widgets that cannot be mirrored."
            : "Complete CAPTCHA, MFA, or legal attestation yourself in the live browser."}
          {" "}
          JobAppAgent will not store codes, cookies, or CAPTCHA answers.
          Filling a form is not an application until you resume and see confirmation on the employer site.
          {!liveNeeded && judgmentUi
            ? " Live browser is optional for this pause."
            : null}
        </p>
        <AttentionActions
          view={view}
          designFixture={key}
          designFixtureUi={ui}
        />
      </section>
    </>
  );
}

function AttentionCard({
  view,
  liveNeeded,
  judgmentUi,
}: {
  view: {
    attentionId: string;
    company: string;
    role: string;
    url: string;
    stage: string;
    blocker: string;
    requiredActions: string[];
    questions: { id: string; prompt: string; kind: string; required: boolean }[];
    aiAssistanceDiscouraged: boolean;
    why: string;
    liveSessionUrl: string | null;
    liveSessionEmbedUrl: string | null;
    liveSessionAvailable: boolean;
    token: string;
    expiresAt: number;
  };
  liveNeeded: boolean;
  judgmentUi: boolean;
}) {
  return (
    <>
      <header className="attention-header">
        <p className="eyebrow">Attention</p>
        <h1>{view.role || "Paused application"}</h1>
        <p className="attention-summary">
          {view.company ? <>at <strong>{view.company}</strong>. </> : null}
          {view.why}
        </p>
        <div className="attention-meta">
          <span className="attention-chip">{blockerLabel(view.blocker)}</span>
          {view.aiAssistanceDiscouraged ? (
            <span className="attention-meta-item">Own voice</span>
          ) : null}
        </div>
      </header>

      <section className="attention-panel" aria-labelledby="required-actions-heading">
        <h2 id="required-actions-heading">What needs you</h2>
        <ul className="attention-checklist">
          {(view.requiredActions.length ? view.requiredActions : ["open-live-session"]).map((action) => (
            <li key={action}>{action === "open-live-session" ? "Open the live browser and finish the paused step" : actionLabel(action)}</li>
          ))}
        </ul>
        {view.url ? (
          <p className="attention-url">
            Application page:{" "}
            <a href={view.url} target="_blank" rel="noreferrer">{view.url}</a>
          </p>
        ) : null}
      </section>

      <section className="attention-panel attention-act-panel" aria-labelledby="act-heading">
        <h2 id="act-heading">{judgmentUi ? "Answer & resume" : "Act in the live browser"}</h2>
        <p>
          {judgmentUi
            ? "Judgment answers stay on this card and are used when you resume. Use the live browser for CAPTCHA, MFA, or widgets that cannot be mirrored."
            : "Complete CAPTCHA, MFA, or legal attestation yourself in the live browser."}
          {" "}
          JobAppAgent will not store codes, cookies, or CAPTCHA answers.
          Filling a form is not an application until you resume and see confirmation on the employer site.
          {!liveNeeded && judgmentUi
            ? " Live browser is optional for this pause."
            : null}
        </p>
        <AttentionActions view={view} />
      </section>
    </>
  );
}

function AttentionShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="attention-page page-width">
      <Link className="legal-back" href="/">← JobAppAgent</Link>
      {children}
    </main>
  );
}

function AttentionError({
  title,
  body,
}: {
  title: string;
  body: string;
}) {
  return (
    <section className="attention-panel attention-error-panel">
      <p className="eyebrow">Attention</p>
      <h1>{title}</h1>
      <p>{body}</p>
      <div className="attention-error-actions">
        <Link className="button" href="/">Back home</Link>
        <p className="attention-error-hint">Need a fresh link? Open your newest Hosted attention email, or ask the run to send another notify.</p>
      </div>
    </section>
  );
}
