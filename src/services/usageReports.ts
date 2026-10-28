import type { UsageReport, UsageReportFormValues } from "../types/usageReport";
import { isDemo } from "../config";
import { demoReports, saveDemoReport, deleteDemoReport } from "../data/demo";
import { requireSupabase } from "./supabaseClient";

interface ReportRow {
  id: string;
  member_id: string;
  display_name: string;
  slurm_user: string;
  resource_pool: string;
  cluster: string;
  start_time: string;
  duration_hours: number;
  node_count: number;
  gpu_count: number;
  gpu_hours: number;
  reason: string;
  created_at: string;
  updated_at: string;
}

const columns = "id,member_id,display_name,slurm_user,resource_pool,cluster,start_time,duration_hours,node_count,gpu_count,gpu_hours,reason,created_at,updated_at";

export async function fetchUsageReports(currentUserId?: string | null): Promise<UsageReport[]> {
  if (isDemo) return demoReports();
  const rows: ReportRow[] = [];
  // Page through results so archived plans cannot crowd new ones out of the API row limit.
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await requireSupabase().from("usage_reports")
      .select(columns).order("start_time", { ascending: true }).order("id")
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as ReportRow[]));
    if (!data || data.length < pageSize) break;
  }
  return rows.map((row) => ({
    id: row.id, memberId: row.member_id, userId: row.member_id,
    userName: row.display_name || "Lab member", userEmail: "", slurmUser: row.slurm_user,
    cluster: row.cluster, resourcePool: row.resource_pool, startTime: row.start_time,
    endTime: new Date(new Date(row.start_time).getTime() + Number(row.duration_hours) * 3_600_000).toISOString(),
    durationHours: Number(row.duration_hours), nodeCount: row.node_count, gpuCount: row.gpu_count,
    gpuHours: Number(row.gpu_hours), reason: row.reason, createdAt: row.created_at,
    updatedAt: row.updated_at, isMine: row.member_id === currentUserId,
  }));
}

export function durationHoursBetween(startTime: string, endTime: string) {
  return (new Date(endTime).getTime() - new Date(startTime).getTime()) / 3_600_000;
}

export async function saveUsageReport(userId: string, values: UsageReportFormValues, reportId?: string | null) {
  if (isDemo) return saveDemoReport(values, reportId);
  const payload = {
    member_id: userId, slurm_user: values.slurmUser.trim(), cluster: values.cluster,
    resource_pool: values.resourcePool, start_time: new Date(values.startTime).toISOString(),
    duration_hours: durationHoursBetween(values.startTime, values.endTime),
    node_count: values.nodeCount, gpu_count: values.gpuCount, reason: values.reason.trim(),
  };
  const db = requireSupabase();
  const { error } = reportId
    ? await db.from("usage_reports").update(payload).eq("id", reportId)
    : await db.from("usage_reports").insert(payload);
  if (error) throw error;
}

export async function deleteUsageReport(reportId: string) {
  if (isDemo) return deleteDemoReport(reportId);
  const { error } = await requireSupabase().from("usage_reports").delete().eq("id", reportId);
  if (error) throw error;
}
