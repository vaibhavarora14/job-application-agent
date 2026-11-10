import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../../../components/SiteChrome";

export const metadata: Metadata = {
  title: "Unsubscribed",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function UnsubscribedPage() {
  return (
    <div className="site-shell">
      <SiteHeader foundingCta={false} />
      <main className="legal page-width">
        <h1>Alerts off.</h1>
        <p><Link href="/jobs" rel="noreferrer">Back to roles</Link></p>
      </main>
      <SiteFooter />
    </div>
  );
}
