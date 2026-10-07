import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return <main className="legal page-width">
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>Founding-access terms.</h1><p>Last updated 30 September 2026.</p>
    <h2>The founding offer</h2><p>The founding offer is a one-time $49 payment for founding hosted access. Checkout is handled by Dodo Payments. Your purchase is confirmed only after a signed payment notification is verified by our server.</p>
    <h2>Access timing</h2><p>Payment reserves founding pricing for hosted access when it launches — it does not start an access window or grant instant access. Hosted and Cloud remain coming soon as separate product surfaces. We confirm your reservation by email after payment is verified.</p>
    <h2>Your responsibility</h2><p>You remain responsible for the accuracy of your profile and every application submitted for you. The agent is designed to pause for uncertain or sensitive answers, but automated software can make mistakes.</p>
    <h2>Product foundation</h2><p>The hosted service uses the same evidence-based runbook as the open-source project and adds continuity, hosted state, and scheduled operation.</p>
  </main>;
}
