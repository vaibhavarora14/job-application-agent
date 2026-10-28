import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

export const metadata: Metadata = {
  title: "Terms",
  alternates: { canonical: "https://jobappagent.com/terms" },
};

export default function Terms() {
  return <div className="site-shell">
    <SiteHeader foundingCta={false} />
    <main className="legal page-width">
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>Founding-access terms.</h1><p>Last updated 13 October 2026.</p>
    <h2>The founding offer</h2><p>The founding offer is a one-time $49 payment for founding cloud access. Checkout is handled by Dodo Payments. Your purchase is confirmed only after a signed payment notification is verified by our server.</p>
    <h2>Access timing</h2><p>Payment reserves founding pricing for cloud access when it launches. It does not start an access window or grant instant access. Cloud access remains coming soon. We confirm your reservation by email after payment is verified.</p>
    <h2>Your responsibility</h2><p>You remain responsible for the accuracy of your profile and every application submitted for you. The agent is designed to pause for uncertain or sensitive answers, but automated software can make mistakes.</p>
    <h2>Agent analytics and contacts</h2><p>If you use the open-source agent skill, default-enabled structured usage analytics and a separate private contact record (saved profile name and email) may apply as described in the Privacy page. Contact data is used for support and product updates; it is not attached to analytics event payloads. You can opt out with the CLI commands documented there.</p>
    <h2>Product foundation</h2><p>The hosted service uses the same evidence-based runbook as the open-source project and adds continuity, hosted state, and scheduled operation.</p>
  </main>
    <SiteFooter />
  </div>;
}
