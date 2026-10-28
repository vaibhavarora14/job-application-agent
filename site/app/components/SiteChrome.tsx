import Link from "next/link";
import type { ReactNode } from "react";
import { FoundingCheckout } from "./FoundingCheckout";

function primaryNavLinks(community: boolean): ReactNode {
  if (community) {
    return <>
      <a href="https://jobappagent.com">Product</a>
      <a href="#methodology">Methodology</a>
    </>;
  }
  return <>
    <Link href="/jobs">Job board</Link>
    <Link href="/#agent">Open source</Link>
    <Link href="/#cloud">Cloud</Link>
    <a href="https://stats.jobappagent.com">Community</a>
  </>;
}

export function SiteHeader({
  community = false,
  foundingCta = true,
}: {
  community?: boolean;
  /** When false, omit Reserve for $49 (+ GST note). Used on /jobs* surfaces. */
  foundingCta?: boolean;
}) {
  return <>
    <nav
      className={`site-nav${foundingCta ? "" : " site-nav-jobs"}`}
      aria-label="Primary navigation"
    >
      <div className="nav-inner page-width">
        <Link className="brand" href={community ? "https://jobappagent.com" : "/#top"} aria-label="JobAppAgent home">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-lockup"><span className="brand-name">JobApp<span>Agent</span></span></span>
        </Link>
        <div className="nav-links">
          {primaryNavLinks(community)}
          {foundingCta ? <FoundingCheckout compact /> : null}
        </div>
        {/* Phone menu for /jobs* (no founding CTA). Hidden on wider breakpoints via CSS. */}
        {!foundingCta ? (
          <details className="site-mobile-menu">
            <summary>Menu</summary>
            <div className="site-mobile-menu-links">
              {primaryNavLinks(community)}
            </div>
          </details>
        ) : null}
      </div>
    </nav>
  </>;
}

export function SiteFooter({ community = false }: { community?: boolean }) {
  return <footer><div className="page-width">
    <span>{community ? "JobAppAgent community activity · identity-free by design" : "JobAppAgent · disciplined work, clear boundaries."}</span>
    <nav className="footer-links" aria-label="Footer">
      {community && <a href="https://jobappagent.com">Product</a>}
      {!community && <><Link href="/jobs">Job board</Link><Link href="/open-source">Open source</Link><Link href="/platforms">Setup guides</Link><Link href="/compare">Compare</Link><a href="https://stats.jobappagent.com">Community stats</a></>}
      <Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link>
    </nav>
  </div></footer>;
}
