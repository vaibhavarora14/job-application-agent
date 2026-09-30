import type { Metadata } from "next";
import Link from "next/link";
import { attentionEnv } from "../../../lib/attention-auth";
import { buyerAttentionStep } from "../../../lib/attention-buyer-flow.mjs";
import { resolveAttentionDesignFixture } from "../../../lib/attention-design-fixtures.mjs";
import { verifyAttentionMagicLink } from "../../../lib/attention-magic-link.mjs";
import { normalizeAttentionQuestions } from "../../../lib/attention-questions.mjs";
import { getAttentionSignal } from "../../../lib/attention-signal-store";
import type { AttentionView } from "./AttentionActions";
import { BuyerFlow } from "./BuyerFlow";

export const metadata: Metadata = { title: "Your applications", robots: { index: false, follow: false } };

export default async function AttentionPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string; design?: string }>;
}) {
  const { id } = await params;
  const attentionId = decodeURIComponent(id ?? "").trim();
  const query = await searchParams;
  // Only the reserved design path and known keys bypass auth, with synthetic data.
  const fixture = resolveAttentionDesignFixture(query, attentionId);
  if (fixture) return <BuyerFlow key={fixture.key} view={fixture.view} initialStep={fixture.step} designFixture />;

  const token = typeof query.token === "string" ? query.token.trim() : "";
  if (!token) return <AttentionError title="This link needs a secure token." />;
  const config = attentionEnv();
  const verified = await verifyAttentionMagicLink(token, config.magicLinkSecret, { attentionId });
  if (!verified.ok || !verified.payload) return <AttentionError title={verified.error === "token_expired" ? "This link has expired." : "This attention link is not valid."} />;

  // No generic question fallback: only the employer's packaged questions need the buyer.
  const payload = verified.payload;
  const view: AttentionView = {
    attentionId,
    company: payload.company ?? "Company",
    role: payload.role ?? "Application",
    questions: normalizeAttentionQuestions(payload.questions),
    aiAssistanceDiscouraged: Boolean(payload.aiAssistanceDiscouraged),
    token,
  };
  const signal = await getAttentionSignal(attentionId);
  return <BuyerFlow view={view} initialStep={signal ? "queue" : buyerAttentionStep(view)} initialSignal={signal?.signal} />;
}

function AttentionError({ title }: { title: string }) {
  return <main className="attention-page page-width">
    <section className="attention-panel attention-error-panel">
      <h1>{title}</h1>
      <p>Open the newest secure link from your JobAppAgent email.</p>
      <div className="attention-error-actions"><Link className="button" href="/">Back home</Link></div>
    </section>
  </main>;
}
