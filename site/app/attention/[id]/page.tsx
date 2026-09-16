import type { Metadata } from "next";
import Link from "next/link";
import { attentionEnv } from "../../../lib/attention-auth";
import { buildLiveSessionProxyPath } from "../../../lib/attention-live-session.mjs";
import { verifyAttentionMagicLink } from "../../../lib/attention-magic-link.mjs";
import { BLOCKER_COPY } from "../../../lib/attention-mail.mjs";
import { AttentionActions, actionLabel } from "./AttentionActions";

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
};

type MagicPayload = {
  attentionId: string;
  company: string;
  role: string;
  url: string;
  stage: string;
  blocker: string;
  requiredActions: string[];
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
  const { token: rawToken } = await searchParams;
  const token = typeof rawToken === "string" ? rawToken.trim() : "";
  const config = attentionEnv();

  if (!token) {
    return <AttentionShell>
      <AttentionError
        title="This attention link needs a token."
        body="Open the signed link from your email. VNC passwords are never emailed — only a short-lived magic link."
      />
    </AttentionShell>;
  }

  const verified = await verifyAttentionMagicLink(token, config.magicLinkSecret, { attentionId }) as VerifyOk | VerifyErr;
  if (!verified.ok) {
    return <AttentionShell>
      <AttentionError
        title={verified.error === "token_expired" ? "This live-session link expired." : "This attention link is not valid."}
        body="Request a fresh notify from the hosted run, or ask the operator to re-send attention mail. Lease hold is typically 45–60 minutes."
      />
    </AttentionShell>;
  }

  const view = verified.payload;
  const why = (BLOCKER_COPY as Record<string, string>)[view.blocker] ?? BLOCKER_COPY.other;
  // Always go through the Worker live-session route (verifies token, then
  // redirects to noVNC with Worker-held password or shows IAP helper).
  const liveSessionUrl = buildLiveSessionProxyPath(view.attentionId, token);

  return (
    <AttentionShell>
      <header className="attention-header">
        <p className="eyebrow">Attention</p>
        <h1>{view.role || "Paused application"}</h1>
        <p className="attention-summary">
          {view.company ? <>at <strong>{view.company}</strong>. </> : null}
          {why}
        </p>
        <div className="attention-meta">
          <span className="attention-chip">{view.blocker || "paused"}</span>
          {view.stage ? <span className="attention-meta-item">stage · {view.stage}</span> : null}
          <span className="attention-meta-item lease">lease held</span>
        </div>
      </header>

      <section className="attention-panel" aria-labelledby="required-actions-heading">
        <h2 id="required-actions-heading">Required actions</h2>
        <ul className="attention-checklist">
          {(view.requiredActions.length ? view.requiredActions : ["open-live-session"]).map((action) => (
            <li key={action}>{action === "open-live-session" ? "Open the live session and finish the paused step" : actionLabel(action)}</li>
          ))}
        </ul>
        {view.url ? (
          <p className="attention-url">
            Application URL:{" "}
            <a href={view.url} target="_blank" rel="noreferrer">{view.url}</a>
          </p>
        ) : null}
      </section>

      <section className="attention-panel" aria-labelledby="act-heading">
        <h2 id="act-heading">Act in the live browser</h2>
        <p>
          Complete CAPTCHA, MFA, legal attestation, or judgment questions yourself.
          JobAppAgent will not store codes, cookies, or CAPTCHA answers.
          filled ≠ applied until you resume and the runner sees a visible confirmation.
        </p>
        <AttentionActions
          view={{
            attentionId: view.attentionId,
            company: view.company,
            role: view.role,
            url: view.url,
            stage: view.stage,
            blocker: view.blocker,
            requiredActions: view.requiredActions,
            why,
            liveSessionUrl,
            token,
            expiresAt: view.expiresAt,
          }}
        />
      </section>
    </AttentionShell>
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

function AttentionError({ title, body }: { title: string; body: string }) {
  return (
    <section className="attention-panel attention-error-panel">
      <p className="eyebrow">Attention</p>
      <h1>{title}</h1>
      <p>{body}</p>
    </section>
  );
}
