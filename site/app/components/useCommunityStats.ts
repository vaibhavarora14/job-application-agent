"use client";

import { useEffect, useState } from "react";

export type CommunityStats = {
  generatedAt: string;
  metrics: {
    installations: number;
    activeInstallations30d: number;
    jobsAssessed: number;
    applicationsSubmitted: number;
    interviews: number;
    offers: number;
  };
  timeline: Array<{ day: string; assessed: number; submitted: number }>;
  breakdowns: {
    ats: Array<{ label: string; count: number }>;
    seniority: Array<{ label: string; count: number }>;
    outcomes: Array<{ label: string; count: number }>;
  };
  privacy: { aggregateOnly: true; minimumSegmentCount: number; identityCollected: false };
  disclosure: { includesHistoricalBackfill: true };
};

export function useCommunityStats() {
  const [data, setData] = useState<CommunityStats | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/community-stats", { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error("stats unavailable");
        return response.json() as Promise<CommunityStats>;
      })
      .then(setData)
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) setError(true);
      });
    return () => controller.abort();
  }, []);

  return { data, error, loading: !data && !error };
}

export const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
export const fullNumber = new Intl.NumberFormat("en");
