import type { Session } from "@supabase/supabase-js";
import { dashboardConfig } from "../config";
import type { LivePayload, LiveJob, LiveHistorySample } from "../types/live";
import type { UsageReport, UsageReportFormValues } from "../types/usageReport";

const epoch = Math.floor(Date.now() / 900_000) * 900_000;
const iso = (hours: number) => new Date(epoch + hours * 3_600_000).toISOString();

export const demoSession: Session = {
  access_token: "", refresh_token: "", expires_in: 0, token_type: "bearer",
  user: {
    id: "demo-member", aud: "demo", app_metadata: {},
    user_metadata: { full_name: "Demo user" }, created_at: iso(-24),
  },
};

export const demoPayloads: Record<string, LivePayload> = Object.fromEntries(
  dashboardConfig.clusters.map((cluster, index) => {
    const jobs: LiveJob[] = [];
    const byUser: LivePayload["byUser"] = {};
    const pools = cluster.pools.map((pool, p) => {
      const used = Math.min(pool.capacity, p === 0 ? (index === 0 ? 10 : 4) : 2);
      const user = cluster.members[p] ?? "alex";
      jobs.push({ jobId: `demo-${index}-${p}`, user, state: "RUNNING", gpus: used,
        gpusPerTask: used, arrayTasks: 1, timeUsed: "01:42:00", timeLimit: "06:00:00",
        nodeList: `${cluster.id.toLowerCase()}-gpu-${p + 1}`, partition: pool.partitions[0],
        reason: null, name: p === 0 ? "representation-learning" : "evaluation", tres: `gres/gpu=${used}` });
      byUser[user] = { runningJobs: 1, gpusUsed: used, pendingJobs: 0, gpusPending: 0 };
      return { key: pool.key, label: pool.label, qos: pool.qos ?? "", partitions: pool.partitions,
        totalGpus: pool.capacity, gpusUsed: used, gpusPending: 0, runningJobs: 1, pendingJobs: 0,
        atCap: used >= pool.capacity, jobsBlockedByAccountCap: 0, gpusBlockedByAccountCap: 0,
        capacitySource: "Example configuration", hardwareGpus: pool.capacity,
        gpusSchedulable: pool.capacity - used, gpusStartableNow: pool.capacity - used };
    });
    const queuedUser = cluster.members[2] ?? "casey";
    jobs.push({ jobId: `demo-${index}-array`, user: queuedUser, state: "PENDING", gpus: 8,
      gpusPerTask: 2, arrayTasks: 4, timeUsed: "0:00", timeLimit: "02:00:00", nodeList: null,
      partition: cluster.pools[0].partitions[0], reason: "Priority", name: "ablation-sweep", tres: "gres/gpu=2" });
    byUser[queuedUser] = { ...(byUser[queuedUser] ?? { runningJobs: 0, gpusUsed: 0 }), pendingJobs: 1, gpusPending: 8 };
    pools[0].gpusPending = 8;
    pools[0].pendingJobs = 1;
    const total = pools.reduce((sum, pool) => sum + pool.totalGpus, 0);
    const used = pools.reduce((sum, pool) => sum + pool.gpusUsed, 0);
    const payload: LivePayload = {
      schemaVersion: "slurm-gpu-v1", cluster: cluster.id, collectedAt: new Date().toISOString(),
      agent: { host: "demo-agent", jobId: null, intervalSeconds: 60, account: cluster.account,
        partitions: cluster.pools.flatMap((pool) => pool.partitions) },
      summary: {
        totalGpus: pools[0].totalGpus, gpusUsed: pools[0].gpusUsed, gpusPending: 8,
        runningJobs: jobs.length - 1, pendingJobs: 1, pools, atAccountCap: false,
        jobsBlockedByAccountCap: 0, gpusBlockedByAccountCap: 0, clusterGpuTotal: total,
        clusterGpuUsed: used, clusterGpuOffline: 0, gpuNodes: pools.length, offlineNodes: 0,
        clusterGpuFree: total - used, clusterGpuReserved: 0, clusterGpuPlanned: 0,
        clusterGpuSchedulable: total - used, reservations: [],
      },
      nodes: pools.map((pool, p) => ({ node: `${cluster.id.toLowerCase()}-gpu-${p + 1}`,
        partitions: pool.partitions, state: "mixed", gpuTotal: pool.totalGpus, gpuUsed: pool.gpusUsed,
        gpuIdx: null, offline: false, cpuAllocated: 24, cpuTotal: 128, memoryMb: 524288,
        gpuFree: pool.totalGpus - pool.gpusUsed, gpuReserved: 0, gpuPlanned: 0,
        gpuSchedulable: pool.totalGpus - pool.gpusUsed })),
      jobs, byUser,
    };
    return [cluster.id, payload];
  }),
);

let reports: UsageReport[] = dashboardConfig.clusters.flatMap((cluster, c) =>
  [0, 1].map((n) => ({
    id: `demo-reservation-${c}-${n}`, memberId: "demo-member", userId: "demo-member",
    userName: "Demo user", userEmail: "", slurmUser: cluster.members[n] ?? "alex",
    cluster: cluster.id, resourcePool: cluster.pools[0].key,
    startTime: iso(n === 0 ? -1 : 3), endTime: iso(n === 0 ? 3 : 7), durationHours: 4,
    nodeCount: 1, gpuCount: Math.min(n === 0 ? 4 : 2, cluster.pools[0].capacity),
    gpuHours: Math.min(n === 0 ? 4 : 2, cluster.pools[0].capacity) * 4,
    reason: n === 0 ? "Representation learning" : "Evaluation sweep",
    createdAt: iso(-24), updatedAt: iso(-1), isMine: true,
  })),
);

export function demoReports() { return reports.map((report) => ({ ...report })); }

export function saveDemoReport(values: UsageReportFormValues, id?: string | null) {
  const durationHours = (new Date(values.endTime).getTime() - new Date(values.startTime).getTime()) / 3_600_000;
  const report: UsageReport = {
    ...values, id: id ?? crypto.randomUUID(), memberId: "demo-member", userId: "demo-member",
    userName: "Demo user", userEmail: "", durationHours, gpuHours: values.gpuCount * durationHours,
    startTime: new Date(values.startTime).toISOString(), endTime: new Date(values.endTime).toISOString(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isMine: true,
  };
  reports = [...reports.filter((row) => row.id !== report.id), report];
}

export function deleteDemoReport(id: string) { reports = reports.filter((row) => row.id !== id); }

export function demoHistory(cluster: string): LiveHistorySample[] {
  const pool = demoPayloads[cluster]?.summary.pools?.[0];
  if (!pool) return [];
  return Array.from({ length: 24 }, (_, hour) => ({ collectedAt: iso(hour - 23),
    totalGpus: pool.totalGpus, gpusUsed: Math.round(pool.gpusUsed * (0.6 + Math.sin(hour / 4) * 0.3)),
    gpusPending: 2, runningJobs: 2, pendingJobs: 1 }));
}
