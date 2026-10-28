import type { UsageReport, UsageReportCluster } from "../types/usageReport";
import { dashboardConfig } from "../config";

export interface ClusterPool { key: string; label: string; capacity: number; }

export const CLUSTER_POOLS: Record<string, ClusterPool[]> = Object.fromEntries(
  dashboardConfig.clusters.map((cluster) => [cluster.id, cluster.pools]),
);
export const CLUSTER_GPU_CAPACITY: Record<string, number> = Object.fromEntries(
  dashboardConfig.clusters.map((cluster) => [cluster.id, cluster.pools[0].capacity]),
);
export const MAX_BOOKING_HOURS = dashboardConfig.maxBookingHours;

export function defaultPoolFor(cluster: UsageReportCluster) {
  return CLUSTER_POOLS[cluster]?.[0]?.key ?? "gpu";
}

export interface CapacityContributor {
  user: string;
  gpuCount: number;
}

export interface CapacityConflict {
  capacity: number;
  /** Peak GPUs already booked at some instant inside the requested window. */
  peakGpus: number;
  /** What the new booking could ask for without exceeding the cap. */
  availableGpus: number;
  /** The busiest sub-interval of the requested window. */
  peakStart: Date;
  peakEnd: Date;
  contributors: CapacityContributor[];
}

interface Interval {
  start: number;
  end: number;
  gpuCount: number;
  user: string;
}

function reportInterval(report: UsageReport): Interval {
  return {
    start: new Date(report.startTime).getTime(),
    end: new Date(report.endTime).getTime(),
    gpuCount: report.gpuCount,
    user: report.slurmUser ?? report.userName,
  };
}

/**
 * Find the busiest instant inside [start, end) and report a conflict when the
 * requested GPUs would not fit alongside what is already booked.
 *
 * A single-reservation check is not enough: three separate 12-GPU bookings each
 * fit under a 32-GPU cap on their own, but overlap for an hour at 36. This
 * sweeps the interval boundaries instead, which is where a concurrent total can
 * change, and so finds the true peak.
 *
 * Intervals are half-open, so a booking ending at 10:00 does not collide with
 * one starting at 10:00.
 */
export function findCapacityConflict({
  capacity,
  cluster,
  end,
  gpuCount,
  ignoreReportId,
  pool,
  reports,
  start,
}: {
  capacity: number;
  cluster: UsageReportCluster;
  end: Date;
  gpuCount: number;
  ignoreReportId?: string | null;
  pool: string;
  reports: UsageReport[];
  start: Date;
}): CapacityConflict | null {
  const windowStart = start.getTime();
  const windowEnd = end.getTime();

  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) {
    return null;
  }

  const overlapping = reports
    .filter(
      (report) =>
        report.cluster === cluster &&
        // Only bookings against the same budget compete: a MIG booking cannot
        // consume a full GPU.
        report.resourcePool === pool &&
        report.id !== ignoreReportId &&
        report.gpuCount > 0,
    )
    .map(reportInterval)
    .filter(
      (interval) => interval.start < windowEnd && windowStart < interval.end,
    );

  // Only the boundaries inside the window can change the concurrent total.
  const boundaries = new Set<number>([windowStart]);
  for (const interval of overlapping) {
    if (interval.start > windowStart && interval.start < windowEnd) {
      boundaries.add(interval.start);
    }
    if (interval.end > windowStart && interval.end < windowEnd) {
      boundaries.add(interval.end);
    }
  }

  const points = [...boundaries].sort((left, right) => left - right);

  let peakGpus = 0;
  let peakStart = windowStart;
  let peakEnd = windowEnd;
  let peakContributors: CapacityContributor[] = [];

  for (let index = 0; index < points.length; index += 1) {
    const sliceStart = points[index];
    const sliceEnd = index + 1 < points.length ? points[index + 1] : windowEnd;
    if (sliceStart >= sliceEnd) {
      continue;
    }

    const active = overlapping.filter(
      (interval) => interval.start <= sliceStart && interval.end > sliceStart,
    );
    const total = active.reduce((sum, interval) => sum + interval.gpuCount, 0);

    if (total > peakGpus) {
      peakGpus = total;
      peakStart = sliceStart;
      peakEnd = sliceEnd;

      const byUser = new Map<string, number>();
      for (const interval of active) {
        byUser.set(
          interval.user,
          (byUser.get(interval.user) ?? 0) + interval.gpuCount,
        );
      }
      peakContributors = [...byUser.entries()]
        .map(([user, count]) => ({ user, gpuCount: count }))
        .sort((left, right) => right.gpuCount - left.gpuCount);
    }
  }

  if (peakGpus + gpuCount <= capacity) {
    return null;
  }

  return {
    capacity,
    peakGpus,
    availableGpus: Math.max(0, capacity - peakGpus),
    peakStart: new Date(peakStart),
    peakEnd: new Date(peakEnd),
    contributors: peakContributors,
  };
}
