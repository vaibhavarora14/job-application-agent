import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return <main className="legal page-width">
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>Privacy, in plain language.</h1><p>Last updated 19 August 2026.</p>
    <h2>Founding purchases</h2><p>The site creates an anonymous purchase reference before sending you to checkout. Dodo Payments collects your email and payment details as our merchant of record. After a signed payment notification, we store the customer email and operational references needed to activate access, support refunds, and resolve disputes. We never receive or store your full card details.</p>
    <h2>Community statistics</h2><p>Public community totals come from anonymous aggregate telemetry. They contain no names, profiles, résumés, emails, or raw installation identifiers. Small segments are grouped to reduce re-identification risk.</p>
    <h2>Why we store it</h2><p>To provide purchased access, enforce the 60-day activation promise, support refunds or disputes, and prevent automated abuse. Rate limiting stores only a pseudonymous identifier derived from a visitor&apos;s network address; the application database does not retain the raw address. We do not sell this information.</p>
    <h2>Your choices</h2><p>You can unsubscribe from any email. For access or deletion requests, open a private contact request through the project&apos;s GitHub profile until a dedicated support address is published.</p>
    <h2>Cloud access</h2><p>The cloud agent will have separate, explicit controls for candidate profiles and application data before it accepts either.</p>
  </main>;
}
