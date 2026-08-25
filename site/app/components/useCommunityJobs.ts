"use client";

import { useCallback, useEffect, useState } from "react";

export type CommunityJob = {
  jobId: string;
  url: string;
  company: string;
  role: string;
  applicationChannel: string;
  discoverySource?: string;
  providerUrl: string;
  firstSeenAt: string;
  lastSeenAt: string;
  contributionCount: number;
};

type CommunityJobPage = { version: 1; jobs: CommunityJob[]; nextCursor: string | null };

async function fetchCommunityJobPage(cursor: string | null, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: "25" });
  if (cursor) query.set("cursor", cursor);
  const response = await fetch(`/api/community-jobs?${query}`, { signal, headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("jobs unavailable");
  return response.json() as Promise<CommunityJobPage>;
}

export function useCommunityJobs() {
  const [jobs, setJobs] = useState<CommunityJob[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetchCommunityJobPage(null, controller.signal)
      .then((page) => {
        setJobs(page.jobs);
        setNextCursor(page.nextCursor);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!(reason instanceof DOMException && reason.name === "AbortError")) {
          setError(true);
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(false);
    try {
      const page = await fetchCommunityJobPage(nextCursor);
      setJobs((current) => {
        const seen = new Set(current.map((job) => job.jobId));
        return [...current, ...page.jobs.filter((job) => !seen.has(job.jobId))];
      });
      setNextCursor(page.nextCursor);
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor]);

  return { jobs, nextCursor, loading, loadingMore, error, loadMore };
}
