"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { onCLS, onINP, onLCP } from "web-vitals";
import {
  FOUNDING_EVENTS,
  bindLandingPageleave,
  captureLandingEvent,
  captureLandingPageview,
  readUtmFromLocation,
} from "../../lib/landing-analytics.mjs";
import { bindLandingWebVitals } from "../../lib/landing-web-vitals.mjs";
import { BROWSER_POSTHOG_INGEST_PATH } from "../../lib/posthog.mjs";

type AnalyticsConfig = {
  apiKey: string;
  host: string;
  ready: boolean;
  capture: (event: string, properties?: Record<string, unknown>) => void;
};

const AnalyticsContext = createContext<AnalyticsConfig>({
  apiKey: "",
  host: BROWSER_POSTHOG_INGEST_PATH,
  ready: false,
  capture() {},
});

export function useLandingAnalytics() {
  return useContext(AnalyticsContext);
}

type RemoteConfig = { apiKey: string; host: string };

export function LandingAnalyticsProvider({ children }: { children: ReactNode }) {
  const [remote, setRemote] = useState<RemoteConfig | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        // Skip analytics config fetch on /jobs* (flag + pathname; no checkout funnel there).
        if (typeof window !== "undefined") {
          const jobsFlag = (window as Window & { __JAA_JOBS_NO_ANALYTICS__?: number }).__JAA_JOBS_NO_ANALYTICS__;
          if (jobsFlag || window.location.pathname.startsWith("/jobs")) return;
        }
        const response = await fetch("/api/analytics-config", { credentials: "omit" });
        if (!active || response.status === 204 || !response.ok) return;
        const body = await response.json() as { apiKey?: string; host?: string };
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey || !active) return;
        setRemote({
          apiKey,
          host: typeof body.host === "string" && body.host.trim() ? body.host.trim() : BROWSER_POSTHOG_INGEST_PATH,
        });
      } catch {
        /* Analytics is best-effort. */
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!remote) return;
    // Jobs board surfaces — landing skip so board filters never ride founding
    // `$current_url`. Personless jobs capture lives in JobsAnalytics.
    if (typeof window !== "undefined") {
      const jobsFlag = (window as Window & { __JAA_JOBS_NO_ANALYTICS__?: number }).__JAA_JOBS_NO_ANALYTICS__;
      if (jobsFlag || window.location.pathname.startsWith("/jobs")) return;
    }
    void captureLandingPageview({ apiKey: remote.apiKey, host: remote.host });
    const stopPageleave = bindLandingPageleave({ apiKey: remote.apiKey, host: remote.host });
    const stopWebVitals = bindLandingWebVitals(
      { apiKey: remote.apiKey, host: remote.host },
      { onLCP, onCLS, onINP },
    );
    return () => {
      stopPageleave();
      stopWebVitals();
    };
  }, [remote]);

  const value = useMemo<AnalyticsConfig>(() => ({
    apiKey: remote?.apiKey ?? "",
    host: remote?.host ?? BROWSER_POSTHOG_INGEST_PATH,
    ready: Boolean(remote?.apiKey),
    capture(event, properties = {}) {
      if (!remote?.apiKey) return;
      void captureLandingEvent({
        apiKey: remote.apiKey,
        host: remote.host,
        event,
        properties,
      });
    },
  }), [remote]);

  return <AnalyticsContext.Provider value={value}>{children}</AnalyticsContext.Provider>;
}

export function trackFoundingCtaClicked(config: AnalyticsConfig | null | undefined) {
  if (!config?.ready) return;
  config.capture(FOUNDING_EVENTS.CTA_CLICKED, {
    offer: "founding_90_days",
    ...readUtmFromLocation(),
  });
}

export { FOUNDING_EVENTS };
