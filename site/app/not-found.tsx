import type { Metadata } from "next";
import Link from "next/link";
import { SiteFooter, SiteHeader } from "./components/SiteChrome";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return <div className="site-shell">
    <SiteHeader />
    <main className="not-found-page">
      <section className="page-width not-found-panel" aria-labelledby="not-found-title">
        <h1 id="not-found-title">We can’t find that page</h1>
        <p>The link may be old or mistyped. Your agent and applications aren’t affected.</p>
        <div className="not-found-actions">
          <Link className="button" href="/">Go to JobAppAgent home</Link>
          <Link className="button button-secondary" href="/jobs">Browse open roles</Link>
        </div>
      </section>
    </main>
    <SiteFooter />
  </div>;
}
