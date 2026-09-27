"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  FOUNDING_EVENTS,
  captureLandingEvent,
  captureLandingPageview,
  readUtmFromLocation,
} from "../../lib/landing-analytics.mjs";
import { DEFAULT_POSTHOG_HOST } from "../../lib/posthog.mjs";

type AnalyticsConfig = {
  apiKey: string;
  host: string;
  ready: boolean;
  capture: (event: string, properties?: Record<string, unknown>) => void;
};

const AnalyticsContext = createContext<AnalyticsConfig>({
  apiKey: "",
  host: DEFAULT_POSTHOG_HOST,
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
        const response = await fetch("/api/analytics-config", { credentials: "omit" });
        if (!active || response.status === 204 || !response.ok) return;
        const body = await response.json() as { apiKey?: string; host?: string };
        const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
        if (!apiKey || !active) return;
        setRemote({
          apiKey,
          host: typeof body.host === "string" && body.host.trim() ? body.host.trim() : DEFAULT_POSTHOG_HOST,
        });
      } catch {
        /* Analytics is best-effort. */
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!remote) return;
    void captureLandingPageview({ apiKey: remote.apiKey, host: remote.host });
  }, [remote]);

  const value = useMemo<AnalyticsConfig>(() => ({
    apiKey: remote?.apiKey ?? "",
    host: remote?.host ?? DEFAULT_POSTHOG_HOST,
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
