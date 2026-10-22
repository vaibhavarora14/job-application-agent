import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy",
  alternates: { canonical: "https://jobappagent.com/privacy" },
};

export default function Privacy() {
  return <main className="legal page-width">
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>Privacy, in plain language.</h1><p>Last updated 21 October 2026.</p>
    <h2>Founding purchases</h2><p>The site creates an anonymous purchase reference before sending you to checkout. Dodo Payments collects your email and payment details as our merchant of record. After a signed payment notification, we store the customer email and operational references needed to fulfill founding hosted access and resolve payment disputes. We never receive or store your full card details.</p>
    <h2>Agent usage analytics</h2><p>Structured usage analytics are enabled by default so we can learn which job sources, ATS flows, and workflow steps work. Analytics events do not include your name, email, phone, résumé content, prompts, answers, browser data, or IP addresses. Error events include only a short sanitized error message, with file paths, your home folder, OS username, and contact details redacted. The analytics retention policy is 24 months; automatic raw-event expiry still requires configuration with PostHog. Run <code>telemetry disable</code> to stop all analytics. Previously collected events are not deleted by opting out.</p>
    <h2>Private contact store</h2><p>Separately from analytics events, the agent may store the name and email you explicitly saved in your candidate profile in a private maintainer database tied to your anonymous install ID. We use this only to support you and send product updates, including when you never contact support yourself. This contact record is not written into PostHog event payloads (since version 3.7.3; the relay also strips name and email fields sent by older versions) and is not exposed on public community or job endpoints. Run <code>telemetry contact disable</code> to stop future contact sharing, or <code>telemetry disable</code> to stop both analytics and contact sharing. Opting out does not automatically delete a contact already stored; for deletion requests, open a private contact request through the project&apos;s GitHub profile until a dedicated support address is published.</p>
    <h2>Community statistics</h2><p>Public community totals contain only aggregate usage counts. They contain no names, profiles, résumés, emails, or raw installation identifiers. Small segments are grouped to reduce re-identification risk.</p>
    <h2>Why we store it</h2><p>To fulfill founding hosted access, support payment disputes, support product users, send product updates, and prevent automated abuse. Rate limiting stores only a pseudonymous identifier derived from a visitor&apos;s network address; the application database does not retain the raw address. We do not sell this information.</p>
    <h2>Your choices</h2><p>You can unsubscribe from any email. Use <code>telemetry contact disable</code> or <code>telemetry disable</code> in the CLI for agent contact/analytics controls. For access or deletion requests, open a private contact request through the project&apos;s GitHub profile until a dedicated support address is published.</p>
    <h2>Cloud access</h2><p>The cloud agent will have separate, explicit controls for candidate profiles and application data before it accepts either.</p>
    <p>About the open-source agent: <Link href="/open-source">About the project</Link> · <Link href="/compare">See how it compares</Link></p>
  </main>;
}
