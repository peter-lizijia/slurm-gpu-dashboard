export interface LiveGpuNode {
  node: string;
  partitions: string[];
  state: string;
  gpuTotal: number;
  gpuUsed: number;
  gpuIdx: string | null;
  /** Drained, down or unreachable: its GPUs are not schedulable capacity. */
  offline: boolean;
  cpuAllocated: number | null;
  cpuTotal: number | null;
  memoryMb: number | null;
  /*
   * Everything below arrived with schema v3 and is optional so a payload from
   * an older agent (one stays in `cluster_live` until it restarts) still
   * renders. Idle is not schedulable: an idle GPU inside somebody else's
   * reservation, or on a node backfill has promised to a queued job, will not
   * run a new job now.
   */
  /** Backfill has promised this node to a queued job it could not start yet. */
  planned?: boolean;
  /** `scontrol reboot` is pending; jobs still start here but it will go away when idle. */
  rebootPending?: boolean;
  /** The ACTIVE reservation covering this node, if any. `name` is null when only the flag was visible. */
  reservation?: LiveNodeReservation | null;
  /**
   * The queued job that shapes this node's number: the one about to take the
   * idle GPUs, else the next one that bounds how long they stay open.
   */
  plannedFor?: LivePlannedJob | null;
  /** Queued jobs the scheduler has planned onto this node, any start time. */
  plannedJobs?: number;
  /** Idle GPUs stay open to a new job until this (cluster-local) time, if known. */
  openUntil?: string | null;
  gpuFree?: number;
  /** Idle GPUs inside a reservation a plain sbatch cannot enter. */
  gpuReserved?: number;
  /** Idle GPUs promised to queued jobs starting within minutes. */
  gpuPlanned?: number;
  /** Idle GPUs a new job could land on right now. */
  gpuSchedulable?: number;
}

export interface LiveNodeReservation {
  name: string | null;
  endTime: string | null;
  /** The lab's account, a lab user or a lab group is on the access list. */
  ours: boolean;
  /** MAGNETIC reservations admit jobs that did not ask for them. */
  magnetic: boolean;
  maintenance: boolean;
}

export interface LivePlannedJob {
  jobId: string;
  /** Null when the job belongs to another group: the payload is public. */
  user: string | null;
  gpus: number;
  gpusPerNode: number;
  nodes: number;
  /** Slurm's predicted start, cluster-local time without a zone. */
  startTime: string | null;
  timeLimit: string;
  partition: string;
}

export interface LiveReservation {
  name: string;
  state: string | null;
  startTime: string | null;
  endTime: string | null;
  /** Watched nodes inside the reservation. */
  nodes: string[];
  nodeCount: number;
  /** Allowed users, count only: member names are not published. */
  userCount: number;
  accounts: string[];
  groups: string[];
  flags: string[];
  magnetic: boolean;
  partition: string | null;
  maintenance: boolean;
  /** True when the lab's account, a lab user or a lab group may use it. */
  ours: boolean;
  /** Idle GPUs on its watched nodes. */
  idleGpus: number;
}

export interface LiveJob {
  jobId: string;
  user: string;
  state: string;
  /** Total GPUs this row demands: `gpusPerTask` times `arrayTasks`. */
  gpus: number;
  /**
   * Optional because a payload written by an agent older than the array-job fix
   * has neither field, and one stays in `cluster_live` until that agent
   * restarts. Treat a missing `arrayTasks` as 1.
   */
  gpusPerTask?: number;
  /** Tasks the row stands for. >1 only on a folded, unstarted array job. */
  arrayTasks?: number;
  timeUsed: string;
  timeLimit: string;
  nodeList: string | null;
  partition: string;
  reason: string | null;
  name: string;
  tres: string;
}

export interface LiveUserUsage {
  runningJobs: number;
  gpusUsed: number;
  pendingJobs: number;
  gpusPending: number;
}

/**
 * One Slurm account's GPU demand on the watched partitions -- every group on
 * the cluster, not just the lab. Aggregates only: the payload is public, so
 * the agent publishes account names and counts but never a username outside
 * the lab, the same rule queued jobs and reservations follow.
 */
export interface LiveAccountUsage {
  account: string;
  /** The agent's own account, i.e. the lab. */
  ours: boolean;
  /** GPUs held by RUNNING jobs. */
  gpusUsed: number;
  /** GPUs asked for by PENDING jobs, array tasks expanded. */
  gpusPending: number;
  runningJobs: number;
  pendingJobs: number;
  /** Distinct users with a GPU job running or queued; a count, not names. */
  users: number;
  /** Running GPUs per quota pool, keyed like `summary.pools[].key`. */
  byPool: Record<string, number>;
}

/**
 * A set of partitions sharing one account GPU cap. The cap belongs to the QOS,
 * not the partition: slice-small and slice-large both run under QOS=mig, so the
 * lab's 8 MIG GPUs are one budget spanning both, not 8 each.
 */
export interface LiveQuotaPool {
  key: string;
  label: string;
  qos: string;
  partitions: string[];
  totalGpus: number | null;
  gpusUsed: number;
  gpusPending: number;
  runningJobs: number;
  pendingJobs: number;
  atCap: boolean;
  jobsBlockedByAccountCap: number;
  gpusBlockedByAccountCap: number;
  capacitySource: string | null;
  /** Physical slices behind the pool, which differs from the quota. */
  hardwareGpus: number;
  /** Schema v3: idle GPUs in the pool not reserved or promised elsewhere. */
  gpusSchedulable?: number;
  /** Schema v3: `gpusSchedulable` capped by the lab's remaining quota. */
  gpusStartableNow?: number;
}

export interface LiveSummary {
  totalGpus: number | null;
  gpusUsed: number;
  gpusPending: number;
  runningJobs: number;
  pendingJobs: number;
  /** Absent on payloads from an agent older than schema v2. */
  pools?: LiveQuotaPool[];
  atAccountCap: boolean;
  jobsBlockedByAccountCap: number;
  gpusBlockedByAccountCap: number;
  clusterGpuTotal: number;
  clusterGpuUsed: number;
  clusterGpuOffline: number;
  gpuNodes: number;
  offlineNodes: number;
  /** Schema v3 split of idle GPUs; all absent on older payloads. */
  clusterGpuFree?: number;
  clusterGpuReserved?: number;
  clusterGpuPlanned?: number;
  clusterGpuSchedulable?: number;
  rebootPendingNodes?: number;
  plannedNodes?: number;
  reservations?: LiveReservation[];
}

export interface LivePayload {
  schemaVersion: string;
  cluster: string;
  collectedAt: string;
  agent: {
    host: string;
    jobId: string | null;
    intervalSeconds: number;
    account: string | null;
    partitions: string[];
  };
  summary: LiveSummary;
  nodes: LiveGpuNode[];
  jobs: LiveJob[];
  byUser: Record<string, LiveUserUsage>;
  /**
   * Sorted by `gpusUsed` descending. Absent on a payload from an agent older
   * than 2026-10-13, which stays in `cluster_live` until that agent reloads.
   */
  byAccount?: LiveAccountUsage[];
}

export interface LiveHistorySample {
  collectedAt: string;
  totalGpus: number | null;
  gpusUsed: number;
  gpusPending: number;
  runningJobs: number;
  pendingJobs: number;
}

export interface LiveClusterState {
  payload: LivePayload;
  /** Seconds between the snapshot being collected and it being read. */
  ageSeconds: number;
  /** True when the agent has not reported for several poll intervals. */
  isStale: boolean;
}
