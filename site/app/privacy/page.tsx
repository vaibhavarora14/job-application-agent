import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

export const metadata: Metadata = {
  title: "Privacy",
  alternates: { canonical: "https://jobappagent.com/privacy" },
};

export default function Privacy() {
  return <div className="site-shell">
    <SiteHeader foundingCta={false} />
    <main className="legal page-width">
    <h1>Privacy, in plain language.</h1><p>Last updated 10 November 2026.</p>
    <h2>Founding purchases</h2><p>The site creates an anonymous purchase reference before sending you to checkout. Dodo Payments collects your email and payment details as our merchant of record. After a signed payment notification, we store the customer email and operational references needed to fulfill founding hosted access and resolve payment disputes. We never receive or store your full card details.</p>
    <h2>Agent usage analytics</h2><p>Structured usage analytics are enabled by default so we can learn which job sources, ATS flows, and workflow steps work. Analytics events do not include your name, email, phone, résumé content, prompts, answers, browser data, or IP addresses. Error events include only a short sanitized error message, with file paths, your home folder, OS username, and contact details redacted. The analytics retention policy is 24 months; automatic raw-event expiry still requires configuration with PostHog. Run <code>telemetry disable</code> to stop all analytics. Previously collected events are not deleted by opting out.</p>
    <h2>Private contact store</h2><p>Separately from analytics events, the agent may store the name and email you explicitly saved in your candidate profile in a private maintainer database tied to your anonymous install ID. We use this only to support you and send product updates, including when you never contact support yourself. This contact record is not written into PostHog event payloads (since version 3.7.3; the relay also strips name and email fields sent by older versions) and is not exposed on public community or job endpoints. Run <code>telemetry contact disable</code> to stop future contact sharing, or <code>telemetry disable</code> to stop both analytics and contact sharing. Opting out does not automatically delete a contact already stored; for deletion requests, open a private contact request through the project&apos;s GitHub profile until a dedicated support address is published.</p>
    <h2>Community statistics</h2><p>Public community totals contain only aggregate usage counts. They contain no names, profiles, résumés, emails, or raw installation identifiers. Small segments are grouped to reduce re-identification risk.</p>
    <h2>Job search alerts</h2><p>If you save a search on the job board, we store only the email address you enter, the filter query (the same filters as the board URL), whether you chose daily or weekly, a confirmation token hash, an unsubscribe token (a random secret that only deletes that saved search), and timestamps for when you subscribed, when you confirmed, when we last sent an alert, and a watermark of the newest role already considered. We send a confirmation email first and send no alerts until you confirm. Each email has a one-click unsubscribe link. Unsubscribing deletes that saved search. Unconfirmed searches are deleted after 7 days. Confirmed searches are kept until you unsubscribe. We do not store your name, résumé, or IP address on the saved search, and the emails we send have no tracking pixels.</p>
    <h2>Why we store it</h2><p>To fulfill founding hosted access, support payment disputes, support product users, send product updates, email new roles that match a search you saved, and prevent automated abuse. Rate limiting stores only a pseudonymous identifier derived from a visitor&apos;s network address; the application database does not retain the raw address. We do not sell this information.</p>
    <h2>Your choices</h2><p>You can unsubscribe from any email. Each saved-search email has an unsubscribe link that deletes that saved search. Use <code>telemetry contact disable</code> or <code>telemetry disable</code> in the CLI for agent contact/analytics controls. For access or deletion requests, open a private contact request through the project&apos;s GitHub profile until a dedicated support address is published.</p>
    <h2>Cloud access</h2><p>The cloud agent will have separate, explicit controls for candidate profiles and application data before it accepts either.</p>
    <p>About the open-source agent: <Link href="/open-source">About the project</Link> · <Link href="/compare">See how it compares</Link></p>
  </main>
    <SiteFooter />
  </div>;
}
