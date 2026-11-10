import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { SiteFooter, SiteHeader } from "../../../components/SiteChrome";
import { unsubscribeSavedSearch } from "../../../../lib/job-alerts.mjs";
import { jobAlertRuntime } from "../../../../lib/job-alerts-runtime.mjs";
import { enforcePublicRateLimit } from "../../../../lib/rate-limit";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

export default async function UnsubscribeAlertPage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};
  const token = typeof params.token === "string" ? params.token : "";
  let limited = false;
  if (token) {
    const incoming = await headers();
    const forwarded = new Headers();
    const ip = incoming.get("cf-connecting-ip");
    const via = incoming.get("x-forwarded-for");
    if (ip) forwarded.set("cf-connecting-ip", ip);
    if (via) forwarded.set("x-forwarded-for", via);
    const gate = await enforcePublicRateLimit(new Request("https://jobappagent.com/jobs/alerts/unsubscribe", { headers: forwarded }), "job-alerts-unsubscribe-page", 30, 900);
    if (gate) limited = true;
    else {
      try {
        const runtime = jobAlertRuntime();
        await runtime.ready;
        await unsubscribeSavedSearch(runtime.store, token);
      } catch {
        limited = true;
      }
    }
  }

  return (
    <div className="site-shell">
      <SiteHeader foundingCta={false} />
      <main className="legal page-width">
        <h1>{limited ? "Try again shortly." : token ? "Alerts off." : "This link is no longer valid."}</h1>
        <p><Link href="/jobs" rel="noreferrer">Back to roles</Link></p>
      </main>
      <SiteFooter />
    </div>
  );
}
