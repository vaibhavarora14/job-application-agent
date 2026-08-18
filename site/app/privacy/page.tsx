import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy" };

export default function Privacy() {
  return <main className="legal page-width">
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>Privacy, in plain language.</h1><p>Last updated 19 August 2026.</p>
    <h2>What the early-access form stores</h2><p>Your email, the role you want, optional location, how you found the page, and whether you want founding access. We do not collect résumés, passwords, demographic answers, or application data on this page.</p>
    <h2>Payments</h2><p>Dodo Payments securely collects and processes checkout and card information as our merchant of record. We store only operational references such as checkout and payment IDs, status, amount, currency, and the time payment was confirmed. We never receive or store your full card details.</p>
    <h2>Why we store it</h2><p>To invite founding users, provide purchased access, support refunds or disputes, understand demand, and send product updates. We do not sell this information.</p>
    <h2>Your choices</h2><p>You can unsubscribe from any email. For access or deletion requests, open a private contact request through the project&apos;s GitHub profile until a dedicated support address is published.</p>
    <h2>Cloud beta</h2><p>The future cloud agent will have separate, explicit controls for candidate profiles and application data before it accepts either.</p>
  </main>;
}
