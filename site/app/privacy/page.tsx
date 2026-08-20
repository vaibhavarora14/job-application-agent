import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return <main className="legal page-width">
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>Privacy, in plain language.</h1><p>Last updated 20 August 2026.</p>
    <h2>Founding purchases</h2><p>The site creates an anonymous purchase reference before sending you to checkout. Dodo Payments collects your email and payment details as our merchant of record. After a signed payment notification, we store the customer email and operational references needed to activate access, deliver the purchase welcome email, support refunds, and resolve disputes. We never receive or store your full card details.</p>
    <h2>Transactional email</h2><p>After a successful purchase, we send one welcome email through Resend. Resend receives your email address and the fixed transactional message needed to deliver it. Open and click tracking are disabled, and a purchase does not add you to marketing email. We retain only delivery status, attempt timestamps, and Resend&apos;s message identifier so webhook retries do not send duplicates.</p>
    <h2>Community statistics</h2><p>Public community totals come from anonymous aggregate telemetry. They contain no names, profiles, résumés, emails, or raw installation identifiers. Small segments are grouped to reduce re-identification risk.</p>
    <h2>Why we store it</h2><p>To provide purchased access, enforce the 60-day activation promise, support refunds or disputes, and prevent automated abuse. Rate limiting stores only a pseudonymous identifier derived from a visitor&apos;s network address; the application database does not retain the raw address. We do not sell this information.</p>
    <h2>Your choices</h2><p>For access, support, or deletion requests, email <a href="mailto:support@jobappagent.com">support@jobappagent.com</a>. Replies are forwarded through ImprovMX to an owner-controlled inbox.</p>
    <h2>Cloud access</h2><p>The cloud agent will have separate, explicit controls for candidate profiles and application data before it accepts either.</p>
  </main>;
}
