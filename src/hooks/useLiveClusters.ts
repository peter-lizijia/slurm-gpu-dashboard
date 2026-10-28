import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchLivePayload,
  fetchLiveSummaries,
  staleAfterSeconds,
} from "../services/liveCluster";
import { isDemo } from "../config";
import type { LiveClusterState, LivePayload } from "../types/live";

interface UseLiveClustersResult {
  live: Record<string, LiveClusterState>;
  isLoading: boolean;
  error: string | null;
  isRefreshing: boolean;
  refresh: () => void;
}

interface CacheEntry {
  collectedAt: string;
  payload: LivePayload;
}

/**
 * Poll live cluster telemetry.
 *
 * Each tick reads only the small summary columns; the full payload is refetched
 * only when `collected_at` moves, reducing repeated payload downloads.
 *
 * Polling pauses while the tab is hidden and resumes with an immediate fetch, so
 * a dashboard left open overnight does not spend the night hitting the API.
 */
export function useLiveClusters(intervalMs = 120_000): UseLiveClustersResult {
  const [live, setLive] = useState<Record<string, LiveClusterState>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cache = useRef<Record<string, CacheEntry>>({});
  const inFlight = useRef(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (inFlight.current) {
      return;
    }

    inFlight.current = true;
    setIsRefreshing(true);

    try {
      setError(null);
      const summaries = await fetchLiveSummaries();
      const now = Date.now();

      const entries = await Promise.all(
        summaries.map(async (summary) => {
          const cached = cache.current[summary.cluster];
          const isSamePoll = cached?.collectedAt === summary.collectedAt;

          const payload = isSamePoll
            ? cached.payload
            : await fetchLivePayload(summary.cluster);

          if (!payload) {
            return null;
          }

          cache.current[summary.cluster] = {
            collectedAt: summary.collectedAt,
            payload,
          };

          const ageSeconds = Math.max(
            0,
            Math.round((now - new Date(summary.collectedAt).getTime()) / 1000),
          );

          const state: LiveClusterState = {
            payload,
            ageSeconds,
            isStale: !isDemo && ageSeconds > staleAfterSeconds(payload),
          };

          return [summary.cluster, state] as const;
        }),
      );

      if (mounted.current) {
        setLive(
          Object.fromEntries(entries.filter((entry) => entry !== null)),
        );
      }
    } catch (error) {
      if (mounted.current) {
        setError(error instanceof Error ? error.message : "Telemetry refresh failed");
        setLive((previous) => Object.fromEntries(Object.entries(previous).map(([key, state]) => [key, { ...state, isStale: true }])));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) {
        setIsRefreshing(false);
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();

    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
    }, intervalMs);

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      mounted.current = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs, load]);

  return { live, error, isLoading, isRefreshing, refresh: () => void load() };
}
