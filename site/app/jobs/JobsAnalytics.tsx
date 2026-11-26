"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import {
  captureJobsPageview,
  jobsCaptureHost,
  rememberJobsDocumentTouch,
  setJobsAnalyticsBrowserConfig,
} from "../../lib/jobs-analytics.mjs";

type RemoteConfig = { apiKey: string; host: string };

/**
 * Personless /jobs capture. Renders nothing. The landing client still skips
 * these routes via `__JAA_JOBS_NO_ANALYTICS__` so board filters never ride
 * landing `$current_url`.
 */
export function JobsAnalytics() {
  const pathname = usePathname();
  const [remote, setRemote] = useState<RemoteConfig | null>(null);

  useEffect(() => {
    // Snapshot UTM + referrer before the config round-trip. Client navigation
    // (or a bounce to the ATS) would otherwise drop google_jobs_apply / referrer.
    rememberJobsDocumentTouch({
      search: window.location.search,
      referrer: document.referrer,
    });
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/analytics-config", { credentials: "omit" });
        if (!active || response.status === 204 || !response.ok) return;
        const body = await response.json() as { apiKey?: string; host?: string };
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey || !active) return;
        const next = {
          apiKey,
          host: jobsCaptureHost(typeof body.host === "string" ? body.host : undefined),
        };
        setJobsAnalyticsBrowserConfig(next);
        setRemote(next);
      } catch {
        /* Analytics is best-effort. */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!remote) return;
    const touch = rememberJobsDocumentTouch({
      search: window.location.search,
      referrer: document.referrer,
    });
    void captureJobsPageview({
      apiKey: remote.apiKey,
      host: remote.host,
      pathname,
      search: touch.search,
      origin: window.location.origin,
      referrer: touch.referrer,
    });
  }, [remote, pathname]);

  return null;
}
