import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Terms" };

export default function Terms() {
  return <main className="legal page-width">
    <Link className="legal-back" href="/">← Back to the product</Link>
    <h1>Founding-access terms.</h1><p>Last updated 20 August 2026.</p>
    <h2>The pre-launch offer</h2><p>JobAppAgent is scheduled to launch on 18 September 2026. The current pre-launch offer is one-time $49 globally, with a localized price of ₹3,999 including GST for purchases localized to India, for 30 days of cloud access from activation. Checkout is handled by Dodo Payments. Your purchase is confirmed only after a signed payment notification is verified by our server. Purchases made under an earlier 90-day offer retain that stored entitlement.</p>
    <h2>Activation and refund promise</h2><p>Your purchased access period begins when your cloud access is activated, not on the payment date. If access has not been activated within 60 days of payment, we automatically request a full refund through Dodo Payments.</p>
    <h2>Your responsibility</h2><p>You remain responsible for the accuracy of your profile and every application submitted for you. The agent is designed to pause for uncertain or sensitive answers, but automated software can make mistakes.</p>
    <h2>Product foundation</h2><p>The cloud service uses the same evidence-based runbook as the open-source project and adds continuity, hosted state, and scheduled operation.</p>
  </main>;
}
