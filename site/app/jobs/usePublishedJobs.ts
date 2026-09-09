"use client";
import { useEffect, useState } from "react";
import type { CommunityJob } from "../components/useCommunityJobs";
import { loadPublishedJobs } from "../../lib/jobs-search.mjs";
export function usePublishedJobs() {
  const [jobs, setJobs] = useState<CommunityJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    loadPublishedJobs(fetch, controller.signal).then((result: CommunityJob[]) => {
      if (!controller.signal.aborted) { setJobs(result); setLoading(false); }
    }).catch(() => {
      if (!controller.signal.aborted) { setError(true); setLoading(false); }
    });
    return () => controller.abort();
  }, [attempt]);
  const retry = () => { setError(false); setLoading(true); setAttempt(value => value + 1); };
  return { jobs, loading, error, retry };
}
