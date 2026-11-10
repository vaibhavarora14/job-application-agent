import type { Metadata } from "next";
import { SiteFooter, SiteHeader } from "../../../components/SiteChrome";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { searchParams?: Promise<Record<string, string | string[] | undefined>> };

/** GET only shows the button. A mailbox prefetch must not delete the row. */
export default async function UnsubscribeAlertPage({ searchParams }: Props) {
  const params = searchParams ? await searchParams : {};
  const token = typeof params.token === "string" ? params.token : "";
  const ready = /^[A-Za-z0-9_-]{43}$/.test(token);

  return (
    <div className="site-shell">
      <SiteHeader foundingCta={false} />
      <main className="legal page-width">
        {ready ? (
          <>
            <h1>Unsubscribe</h1>
            <form method="POST" action="/api/jobs/alerts/unsubscribe">
              <input type="hidden" name="token" value={token} />
              <button className="button" type="submit">Unsubscribe</button>
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
