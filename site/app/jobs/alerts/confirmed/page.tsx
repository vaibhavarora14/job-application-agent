import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "../../../components/SiteChrome";

export const metadata: Metadata = {
  title: "Alerts confirmed",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function AlertsConfirmedPage() {
  return (
    <div className="site-shell">
      <SiteHeader foundingCta={false} />
      <main className="legal page-width">
        <h1>Alerts confirmed.</h1>
        <p><Link href="/jobs">Back to roles</Link></p>
      </main>
      <SiteFooter />
    </div>
  );
}
