export type UsageReportCluster = string;

export interface UsageReportFormValues {
  cluster: UsageReportCluster;
  /** Which account GPU budget this books against. */
  resourcePool: string;
  /** Cluster account that will run the jobs, used to match live usage. */
  slurmUser: string;
  nodeCount: number;
  gpuCount: number;
  /** Local datetime-local input value. */
  startTime: string;
  /** Local datetime-local input value. */
  endTime: string;
  reason: string;
}

export interface UsageReport {
  id: string;
  memberId: string;
  userId: string;
  userName: string;
  userEmail: string;
  slurmUser: string | null;
  cluster: UsageReportCluster;
  resourcePool: string;
  startTime: string;
  /** Derived from startTime + durationHours; the form works in end times. */
  endTime: string;
  durationHours: number;
  nodeCount: number;
  gpuCount: number;
  gpuHours: number;
  reason: string;
  createdAt: string;
  updatedAt: string;
  isMine: boolean;
}
