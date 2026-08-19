import Link from "next/link";
import { FoundingCheckout } from "./FoundingCheckout";

export function SiteHeader({ community = false }: { community?: boolean }) {
  return <>
    {!community && <div className="topbar"><strong>FOUNDING CLOUD ACCESS</strong><span>$49 globally · ₹3,999 including GST in India · 90 days from activation</span></div>}
    <nav className="site-nav" aria-label="Primary navigation"><div className="nav-inner page-width">
      <a className="brand" href={community ? "https://jobappagent.com" : "#top"}><span className="brand-mark">JA</span><span>Job Application Agent</span></a>
      <div className="nav-links">
        {community ? <><a href="https://jobappagent.com">Product</a><a href="#methodology">Methodology</a></> : <><a href="https://stats.jobappagent.com">Community</a><a href="#process">How it works</a><a href="#boundaries">Boundaries</a></>}
        <FoundingCheckout compact />
      </div>
    </div></nav>
  </>;
}

export function SiteFooter({ community = false }: { community?: boolean }) {
  return <footer><div className="page-width">
    <span>{community ? "Community pulse · identity-free by design" : "Job Application Agent · verified facts, clear boundaries."}</span>
    <div>{community && <a href="https://jobappagent.com">Product</a>}<Link href="/privacy">Privacy</Link><Link href="/terms">Terms</Link></div>
  </div></footer>;
}
