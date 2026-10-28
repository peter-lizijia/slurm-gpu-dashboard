import type { LiveHistorySample, LivePayload } from "../types/live";
import { isDemo } from "../config";
import { demoPayloads, demoHistory } from "../data/demo";
import { requireSupabase } from "./supabaseClient";

// Poll summaries first; fetch full node/job payloads only when their timestamps change.

const SUMMARY_COLUMNS =
  "cluster,collected_at,total_gpus,gpus_used,gpus_pending,running_jobs,pending_jobs";

export interface LiveSummaryRow {
  cluster: string;
  collectedAt: string;
  totalGpus: number | null;
  gpusUsed: number;
  gpusPending: number;
  runningJobs: number;
  pendingJobs: number;
}

interface SummaryRow {
  cluster: string;
  collected_at: string;
  total_gpus: number | null;
  gpus_used: number | null;
  gpus_pending: number | null;
  running_jobs: number | null;
  pending_jobs: number | null;
}

interface HistoryRow {
  collected_at: string;
  total_gpus: number | null;
  gpus_used: number | null;
  gpus_pending: number | null;
  running_jobs: number | null;
  pending_jobs: number | null;
}

function toNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Poll compact summaries before downloading changed payloads. */
export async function fetchLiveSummaries(): Promise<LiveSummaryRow[]> {
  if (isDemo) return Object.values(demoPayloads).map((p) => ({ cluster: p.cluster, collectedAt: p.collectedAt, ...p.summary }));
  const { data, error } = await requireSupabase()
    .from("cluster_live")
    .select(SUMMARY_COLUMNS);

  if (error) throw error;

  return ((data ?? []) as SummaryRow[]).map((row) => ({
    cluster: row.cluster,
    collectedAt: row.collected_at,
    totalGpus: row.total_gpus,
    gpusUsed: toNumber(row.gpus_used),
    gpusPending: toNumber(row.gpus_pending),
    runningJobs: toNumber(row.running_jobs),
    pendingJobs: toNumber(row.pending_jobs),
  }));
}

/** Expensive read: the full node and job detail for one cluster. */
export async function fetchLivePayload(
  cluster: string,
): Promise<LivePayload | null> {
  if (isDemo) return demoPayloads[cluster] ?? null;
  const { data, error } = await requireSupabase()
    .from("cluster_live")
    .select("payload")
    .eq("cluster", cluster)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const payload = (data as { payload: LivePayload }).payload;
  return payload && payload.summary ? payload : null;
}

export async function fetchLiveHistory(
  cluster: string,
  hours = 24,
): Promise<LiveHistorySample[]> {
  if (isDemo) return demoHistory(cluster);
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const { data, error } = await requireSupabase()
    .from("cluster_live_history")
    .select(
      "collected_at,total_gpus,gpus_used,gpus_pending,running_jobs,pending_jobs",
    )
    .eq("cluster", cluster)
    .gte("collected_at", since)
    .order("collected_at", { ascending: true });

  if (error || !data) {
    return [];
  }

  return (data as HistoryRow[]).map((row) => ({
    collectedAt: row.collected_at,
    totalGpus: row.total_gpus,
    gpusUsed: toNumber(row.gpus_used),
    gpusPending: toNumber(row.gpus_pending),
    runningJobs: toNumber(row.running_jobs),
    pendingJobs: toNumber(row.pending_jobs),
  }));
}

const STALE_INTERVAL_MULTIPLIER = 4;
const FALLBACK_STALE_SECONDS = 300;

export function staleAfterSeconds(payload: LivePayload | null): number {
  const interval = payload?.agent?.intervalSeconds;
  return typeof interval === "number" && interval > 0
    ? interval * STALE_INTERVAL_MULTIPLIER
    : FALLBACK_STALE_SECONDS;
}
