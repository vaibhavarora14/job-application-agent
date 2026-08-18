import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return <main className="legal page-width">
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>Founding-access terms.</h1><p>Last updated 19 August 2026.</p>
    <h2>What registration means</h2><p>Joining records your interest. It does not guarantee a launch date, a job interview, or employment.</p>
    <h2>The founding offer</h2><p>The founding offer is a one-time $49 purchase for 90 days of cloud beta access. Checkout is handled by Dodo Payments. Your place is reserved only after a signed payment notification is verified by our server.</p>
    <h2>Beta availability</h2><p>Cloud access begins when your founding place is activated, not necessarily on the payment date. If we cannot provide the promised 90-day access, contact us for a remedy or refund through Dodo Payments.</p>
    <h2>Your responsibility</h2><p>You remain responsible for the accuracy of your profile and every application submitted for you. The agent is designed to pause for uncertain or sensitive answers, but automated software can make mistakes.</p>
    <h2>Open-source local agent</h2><p>The local project remains governed by the license published in its GitHub repository.</p>
  </main>;
}
