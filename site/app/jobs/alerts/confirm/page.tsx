import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../../components/SiteChrome";
import { confirmTokenReady } from "../../../../lib/job-alerts.mjs";
import { jobAlertRuntime } from "../../../../lib/job-alerts-runtime.mjs";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm job alert",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

function tokenFrom(params: Record<string, string | string[] | undefined>) {
  const value = params.token;
  return typeof value === "string" ? value : "";
}

export default async function ConfirmAlertPage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};
  const failed = params.error === "1";
  let ready = false;
  const token = tokenFrom(params);
  if (!failed && token) {
    try {
      const runtime = jobAlertRuntime();
      await runtime.ready;
      ready = await confirmTokenReady(runtime.store, token);
    } catch {
      ready = false;
    }
  }

  return (
    <div className="site-shell">
      <SiteHeader foundingCta={false} />
      <main className="legal page-width">
        {ready ? (
          <>
            <h1>Confirm alerts</h1>
            <form method="POST" action="/api/jobs/alerts/confirm">
              <input type="hidden" name="token" value={token} />
              <button className="button" type="submit">Confirm alerts</button>
            </form>
          </>
        ) : (
          <h1>This link is no longer valid.</h1>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
