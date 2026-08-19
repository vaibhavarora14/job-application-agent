import Link from "next/link";
import { FoundingCheckout } from "./FoundingCheckout";

export function SiteHeader({ community = false }: { community?: boolean }) {
  return <>
    {!community && <div className="topbar"><strong>FOUNDING CLOUD ACCESS</strong><span>$49 globally · ₹3,999 including GST in India · 90 days from activation</span></div>}
    <nav className="site-nav" aria-label="Primary navigation"><div className="nav-inner page-width">
      <a className="brand" href={community ? "https://jobappagent.com" : "#top"} aria-label="JobAppAgent home">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-lockup"><span className="brand-name">JobApp<span>Agent</span></span><span className="brand-tagline">Autonomous job search</span></span>
      </a>
      <div className="nav-links">
        {community ? <><a href="https://jobappagent.com">Product</a><a href="#methodology">Methodology</a></> : <><a href="https://stats.jobappagent.com">Community</a><a href="#process">How it works</a><a href="#boundaries">Boundaries</a></>}
        <FoundingCheckout compact />
      </div>
    </div></nav>
  </>;
}

export function SiteFooter({ community = false }: { community?: boolean }) {
  return <footer><div className="page-width">
    <span>{community ? "JobAppAgent community pulse · identity-free by design" : "JobAppAgent · verified facts, clear boundaries."}</span>
    <div>{community && <a href="https://jobappagent.com">Product</a>}<Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></div>
  </div></footer>;
}
