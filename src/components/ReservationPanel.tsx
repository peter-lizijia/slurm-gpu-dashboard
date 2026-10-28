import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { clusterOptions } from "../config";
import { CalendarCheck, Plus, Trash2, X } from "lucide-react";
import type { Session } from "@supabase/supabase-js";
import {
  deleteUsageReport,
  durationHoursBetween,
  fetchUsageReports,
  saveUsageReport,
} from "../services/usageReports";
import type { ClusterData } from "../types/dashboard";
import type { LiveClusterState } from "../types/live";
import type {
  UsageReport,
  UsageReportCluster,
  UsageReportFormValues,
} from "../types/usageReport";
import {
  CLUSTER_GPU_CAPACITY,
  CLUSTER_POOLS,
  MAX_BOOKING_HOURS,
  defaultPoolFor,
  findCapacityConflict,
} from "../utils/reservationCapacity";
import {
  formatCountdown,
  formatDurationHours,
  formatShortDateTime,
  getDefaultPlanStartTime,
  getDefaultReservationEndTime,
  toLocalDateTimeInputValue,
} from "../utils/dateTime";

interface ReservationPanelProps {
  authLoading: boolean;
  clusters: ClusterData[];
  live: Record<string, LiveClusterState>;
  session: Session | null;
  onSignIn: () => void;
  /** Lifted so the page can render planning analysis without a second fetch. */
  onReportsChange?: (reports: UsageReport[]) => void;
}

const slurmUserStorageKey = "slurm-lab-dashboard-slurm-user";

function createInitialValues(
  slurmUser: string,
  cluster: UsageReportCluster = clusterOptions[0],
): UsageReportFormValues {
  const startTime = getDefaultPlanStartTime();
  return {
    cluster,
    resourcePool: defaultPoolFor(cluster),
    slurmUser,
    // Slurm allocates GPUs, not whole machines, so the board asks for GPUs
    // only. The column stays at its default so existing rows and the schema
    // are untouched.
    nodeCount: 1,
    gpuCount: 1,
    startTime,
    endTime: getDefaultReservationEndTime(startTime),
    reason: "",
  };
}

function readStoredSlurmUser() {
  try {
    return window.localStorage.getItem(slurmUserStorageKey) ?? "";
  } catch {
    return "";
  }
}

/**
 * PostgREST reports an unapplied migration as a missing column, which is
 * accurate but unreadable for anyone who does not run the database. Translate
 * it into the action that actually fixes it.
 */
function describeError(error: unknown, email?: string | null) {
  const message = (error as Error).message ?? String(error);
  const code = (error as { code?: string }).code;

  if (/column .*(node_count|slurm_user|resource_pool)/.test(message) || message.includes("schema cache")) {
    return "Database is missing reservation columns. Ask the dashboard administrator to update the database schema.";
  }

  // The allowlist rejects the row at the policy level, which surfaces as a bare
  // "violates row-level security policy". Say what actually happened instead.
  if (code === "42501" || /row-level security/i.test(message)) {
    return `${
      email ? `${email} is` : "This account is"
    } not on the lab allowlist, so it cannot create or edit reservations. Ask the dashboard administrator to approve this account.`;
  }

  return message;
}

/**
 * Numeric fields are kept as raw strings while editing.
 *
 * Coercing on every keystroke (`Number(value) || 1`) makes the field
 * un-editable: clearing it to type a new number snaps it straight back to 1,
 * so the only way to change 1 to 8 is select-all-then-type. Instead, allow an
 * empty string during editing and clamp on blur and on submit.
 */
function sanitizeCount(raw: string, maxDigits = 3) {
  return raw.replace(/\D/g, "").replace(/^0+(?=\d)/, "").slice(0, maxDigits);
}

function clampCount(raw: string, max: number) {
  const parsed = Number(sanitizeCount(raw));
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.min(max, Math.round(parsed));
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Key for the per-cluster-per-account maps.
 *
 * A function rather than an inline template because the first version built the
 * key one way where it was written and another way where it was read, so every
 * lookup missed and the totals silently fell back to a single booking. One
 * definition makes that class of bug impossible. NUL separates because a Google
 * display name can contain spaces.
 */
function usageKey(cluster: string, user: string, pool: string) {
  return `${cluster}\u0000${pool}\u0000${user}`;
}

interface ReservationRowProps {
  /** GPUs this person has booked on this cluster in windows already running. */
  bookedNowGpus: number;
  canEdit: boolean;
  liveGpus: number | null;
  now: number;
  report: UsageReport;
  onDelete: (report: UsageReport) => void;
  onEdit: (report: UsageReport) => void;
}

function ReservationRow({
  bookedNowGpus,
  canEdit,
  liveGpus,
  now,
  report,
  onDelete,
  onEdit,
}: ReservationRowProps) {
  const start = new Date(report.startTime).getTime();
  const end = new Date(report.endTime).getTime();
  const isActive = start <= now && now < end;
  const remaining = end - now;
  const progress = isActive
    ? Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100))
    : 0;
  // Counts only bookings already under way, and shows only on those rows. A
  // reservation that starts tomorrow is not holding anything yet, so folding it
  // in read as "37 GPUs" while nine were actually in use -- and put that number
  // on rows whose own booking had not begun.
  // Compared against what has already started, not the row's own GPU count:
  // someone running 6 across three 2-GPU bookings is exactly within what they
  // reserved, and flagging all three rows would be wrong three times over.
  const isOverusing = liveGpus !== null && liveGpus > bookedNowGpus;

  return (
    <li className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
      <span
        aria-hidden="true"
        className={`h-2.5 w-2.5 shrink-0 rounded-full ${
          isActive
            ? "animate-pulse bg-emerald-500"
            : "bg-slate-300 dark:bg-slate-600"
        }`}
      />

      <div className="min-w-0 flex-1 basis-40">
        <div className="flex items-baseline gap-2">
          <p className="truncate font-semibold text-ink-950 dark:text-white">
            {report.slurmUser || report.userName}
          </p>
          {liveGpus !== null && liveGpus > 0 ? (
            <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
              {liveGpus} live
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 truncate text-sm text-ink-500 dark:text-slate-400">
          {report.cluster}
          {CLUSTER_POOLS[report.cluster]?.length > 1
            ? ` · ${
                CLUSTER_POOLS[report.cluster].find(
                  (pool) => pool.key === report.resourcePool,
                )?.label ?? report.resourcePool
              }`
            : ""}{" "}
          · {plural(report.gpuCount, "GPU")}
          {report.reason ? ` · ${report.reason}` : ""}
        </p>
        {isOverusing ? (
          <p className="mt-1.5 text-xs font-medium leading-relaxed text-sky-700 dark:text-sky-300">
            Running {liveGpus} GPUs; {bookedNowGpus} reserved in this pool.
          </p>
        ) : null}
        {/* Keep usage and reservations scoped to their cluster and pool. */}
        {isActive ? (
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <div
              className="h-full rounded-full bg-emerald-500 transition-all dark:bg-emerald-400"
              style={{ width: `${progress}%` }}
            />
          </div>
        ) : null}
      </div>

      <div className="shrink-0 text-right">
        {/* Only a running booking gets a countdown. Showing one before the
            start was ambiguous: "25:39" on a four-hour booking read as
            "nearly over" when it meant "starts in 25 minutes". */}
        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-500 dark:text-slate-400">
          {isActive ? "remaining" : "starts"}
        </p>
        <p
          className={`font-mono text-lg font-semibold leading-tight tabular-nums ${
            isActive
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-slate-300 dark:text-slate-600"
          }`}
        >
          {isActive ? formatCountdown(remaining) : "---"}
        </p>
        <p className="text-xs font-medium text-ink-500 dark:text-slate-400">
          {isActive
            ? `ends ${formatShortDateTime(new Date(end))}`
            : `${formatShortDateTime(new Date(start))} · ${formatDurationHours(report.durationHours)}`}
        </p>
      </div>

      {canEdit && report.isMine ? (
        <div className="flex shrink-0 flex-col gap-1">
          <button
            aria-label="Edit reservation"
            className="rounded p-1 text-ink-500 transition hover:bg-slate-100 hover:text-ink-950 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
            onClick={() => onEdit(report)}
            title="Edit"
            type="button"
          >
            <CalendarCheck aria-hidden="true" className="h-4 w-4" />
          </button>
          <button
            aria-label="Delete reservation"
            className="rounded p-1 text-ink-500 transition hover:bg-red-50 hover:text-red-600 dark:text-slate-400 dark:hover:bg-red-950/50 dark:hover:text-red-300"
            onClick={() => onDelete(report)}
            title="Delete"
            type="button"
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
      ) : null}
    </li>
  );
}

export function ReservationPanel({
  authLoading,
  clusters,
  live,
  session,
  onSignIn,
  onReportsChange,
}: ReservationPanelProps) {
  const [reports, setReports] = useState<UsageReport[]>([]);
  const [values, setValues] = useState<UsageReportFormValues>(() =>
    createInitialValues(readStoredSlurmUser()),
  );
  const [gpuInput, setGpuInput] = useState("1");
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const isSignedIn = Boolean(session?.user.id);

  const lastLoadedAt = useRef(0);

  async function loadReports(userId?: string | null) {
    setError(null);
    try {
      const next = await fetchUsageReports(userId ?? null);
      lastLoadedAt.current = Date.now();
      setReports(next);
      onReportsChange?.(next);
    } catch (loadError) {
      setError(describeError(loadError, session?.user.email));
    }
  }

  useEffect(() => {
    void loadReports(session?.user.id ?? null);
  }, [session?.user.id]);

  // Reservations are otherwise only fetched on load and after your own edits,
  // so a teammate's new booking would stay invisible until a reload. Refetching
  // when the tab regains focus fixes that for the price of one request per
  // return visit, rather than a background poll that runs all day.
  useEffect(() => {
    const refreshIfStale = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      // Flicking between tabs should not fire a request each time.
      if (Date.now() - lastLoadedAt.current < 30_000) {
        return;
      }
      void loadReports(session?.user.id ?? null);
    };

    document.addEventListener("visibilitychange", refreshIfStale);
    window.addEventListener("focus", refreshIfStale);

    return () => {
      document.removeEventListener("visibilitychange", refreshIfStale);
      window.removeEventListener("focus", refreshIfStale);
    };
  }, [session?.user.id]);

  /** Known cluster accounts, for the username picker. */
  const knownUsers = useMemo(() => {
    const names = new Set<string>();
    for (const cluster of clusters) {
      for (const member of cluster.members) {
        if (member.name) {
          names.add(member.name);
        }
      }
    }
    for (const state of Object.values(live)) {
      for (const name of Object.keys(state.payload.byUser)) {
        names.add(name);
      }
    }
    return [...names].sort();
  }, [clusters, live]);

  /**
   * The typed account must be one we have actually seen on a cluster.
   *
   * Empty is not "unknown" -- `required` already covers that, and flagging a
   * field the moment it is focused and still blank is just noise.
   */
  const isUnknownUser = useMemo(() => {
    const typed = values.slurmUser.trim();
    return typed.length > 0 && knownUsers.length > 0 && !knownUsers.includes(typed);
  }, [knownUsers, values.slurmUser]);

  /* Keep usage and reservations scoped to their cluster and pool. */
  const liveGpusByUser = useMemo(() => {
    const usage: Record<string, number> = {};
    for (const state of Object.values(live)) {
      const cluster = state.payload.cluster;
      if (state.isStale) continue;
      for (const job of state.payload.jobs) {
        if (job.state.toUpperCase() !== "RUNNING") continue;
        const pool = state.payload.summary.pools?.find((p) => !p.partitions.length || p.partitions.includes(job.partition));
        const key = usageKey(cluster, job.user, pool?.key ?? defaultPoolFor(cluster));
        usage[key] = (usage[key] ?? 0) + job.gpus;
      }
    }
    return usage;
  }, [live]);

  // Anything whose countdown has run out is simply dropped. Because this is
  // derived from `now`, which ticks every second, a reservation leaves the page
  // the moment it expires -- no reload, and no refetch.
  const { active, upcoming } = useMemo(() => {
    const activeList: UsageReport[] = [];
    const upcomingList: UsageReport[] = [];

    for (const report of reports) {
      const start = new Date(report.startTime).getTime();
      const end = new Date(report.endTime).getTime();
      if (end <= now) {
        continue;
      }
      if (start <= now) {
        activeList.push(report);
      } else {
        upcomingList.push(report);
      }
    }

    activeList.sort(
      (a, b) => new Date(a.endTime).getTime() - new Date(b.endTime).getTime(),
    );
    upcomingList.sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
    );

    return { active: activeList, upcoming: upcomingList };
  }, [now, reports]);

  // Tick only while something is still counting down. Deriving this from the
  // live lists rather than from `reports` means the timer stops on its own once
  // the last reservation expires, instead of running against a stale snapshot.
  const hasCountdown = active.length > 0 || upcoming.length > 0;

  useEffect(() => {
    if (!hasCountdown) {
      return;
    }

    const tick = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
      }
    };

    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [hasCountdown]);

  const activeGpus = active.reduce((total, report) => total + report.gpuCount, 0);

  /* Keep usage and reservations scoped to their cluster and pool. */
  const bookedNowGpus = useMemo(() => {
    const started: Record<string, number> = {};
    for (const report of active) {
      const key = usageKey(report.cluster, report.slurmUser || report.userName, report.resourcePool);
      started[key] = (started[key] ?? 0) + report.gpuCount;
    }
    return started;
  }, [active]);

  const durationHours = durationHoursBetween(values.startTime, values.endTime);
  const isTooShort = durationHours < 0.25;
  const isTooLong = durationHours > MAX_BOOKING_HOURS;
  const isWindowValid = Number.isFinite(durationHours) && !isTooShort && !isTooLong;

  /** Latest end the picker will offer, so the limit is visible before it bites. */
  const latestEnd = useMemo(() => {
    const start = new Date(values.startTime);
    if (!Number.isFinite(start.getTime())) {
      return undefined;
    }
    return toLocalDateTimeInputValue(
      new Date(start.getTime() + MAX_BOOKING_HOURS * 3_600_000),
    );
  }, [values.startTime]);

  const pools = CLUSTER_POOLS[values.cluster] ?? [];

  // The live agent reports each pool's cap straight from sacctmgr, so its
  // number wins; the table above is the fallback when the agent is down or the
  // cluster has no agent at all.
  const capacity =
    (!live[values.cluster]?.isStale ? live[values.cluster]?.payload.summary.pools?.find(
      (pool) => pool.key === values.resourcePool,
    )?.totalGpus : undefined) ??
    pools.find((pool) => pool.key === values.resourcePool)?.capacity ??
    pools[0].capacity;

  const conflict = useMemo(() => {
    if (!isWindowValid || values.gpuCount < 1) {
      return null;
    }

    return findCapacityConflict({
      capacity,
      cluster: values.cluster,
      end: new Date(values.endTime),
      gpuCount: values.gpuCount,
      ignoreReportId: editingId,
      pool: values.resourcePool,
      reports,
      start: new Date(values.startTime),
    });
  }, [
    capacity,
    editingId,
    isWindowValid,
    reports,
    values.cluster,
    values.endTime,
    values.gpuCount,
    values.resourcePool,
    values.startTime,
  ]);

  function openForm(cluster: UsageReportCluster) {
    const initial = createInitialValues(readStoredSlurmUser(), cluster);
    setValues(initial);
    setGpuInput(String(initial.gpuCount));
    setEditingId(null);
    setIsFormOpen(true);
  }

  function closeForm() {
    setIsFormOpen(false);
    setEditingId(null);
    setError(null);
  }

  function handleEdit(report: UsageReport) {
    setValues({
      cluster: report.cluster,
      resourcePool: report.resourcePool,
      // Carried through untouched: the form no longer shows it, so editing a
      // booking must not quietly reset what is already stored.
      nodeCount: report.nodeCount,
      slurmUser: report.slurmUser ?? "",
      gpuCount: report.gpuCount,
      startTime: toLocalDateTimeInputValue(new Date(report.startTime)),
      endTime: toLocalDateTimeInputValue(new Date(report.endTime)),
      reason: report.reason,
    });
    setGpuInput(String(report.gpuCount));
    setEditingId(report.id);
    setIsFormOpen(true);
  }

  async function handleDelete(report: UsageReport) {
    if (!window.confirm(`Delete ${report.slurmUser ?? report.userName}'s reservation?`)) {
      return;
    }

    try {
      await deleteUsageReport(report.id);
      await loadReports(session?.user.id ?? null);
    } catch (deleteError) {
      setError(describeError(deleteError, session?.user.email));
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // isUnknownUser is checked here too, not just on the disabled button: the
    // datalist lets the browser autofill on Enter, which can submit the form in
    // the same keystroke that changes the value.
    if (!session?.user.id || !isWindowValid || isUnknownUser || conflict) {
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const normalized = {
        ...values,
        gpuCount: clampCount(gpuInput, 256),
      };
      await saveUsageReport(session.user.id, normalized, editingId);
      try {
        window.localStorage.setItem(slurmUserStorageKey, values.slurmUser);
      } catch {
        // A blocked localStorage is not a reason to fail the save.
      }
      closeForm();
      await loadReports(session.user.id);
    } catch (saveError) {
      setError(describeError(saveError, session?.user.email));
    } finally {
      setIsSaving(false);
    }
  }

  const inputClass =
    "h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-ink-950 outline-none transition focus:border-emerald-500 focus:ring-4 focus:ring-emerald-100 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:focus:border-emerald-400 dark:focus:ring-emerald-900/50";
  const labelClass =
    "grid gap-1 text-xs font-semibold uppercase tracking-wide text-ink-500 dark:text-slate-400";

  // Rendered inside whichever cluster block is being booked, so the form
  // opens next to the list it will add to rather than at the top of the
  // panel. Changing the Cluster field moves it to the other block, which is
  // the same thing the field is saying.
  const renderForm = () => (
    <form
      className="mt-4 grid gap-3 rounded-lg border border-slate-200 bg-cloud-50 p-4 dark:border-slate-800 dark:bg-slate-950"
      onSubmit={handleSubmit}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={labelClass}>
          Slurm username
          <input
            aria-describedby="slurm-lab-slurm-user-hint"
            aria-invalid={isUnknownUser}
            className={`${inputClass} ${
              isUnknownUser
                ? "border-amber-400 focus:border-amber-500 focus:ring-amber-100 dark:border-amber-600 dark:focus:border-amber-500 dark:focus:ring-amber-900/50"
                : ""
            }`}
            list="slurm-lab-slurm-users"
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                slurmUser: event.target.value,
              }))
            }
            placeholder="alex"
            required
            value={values.slurmUser}
          />
          <datalist id="slurm-lab-slurm-users">
            {knownUsers.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {/* The field feeds the live-usage match, which is done on the
              Slurm username. A display name or a typo silently never
              matches, so the booking just never shows a live badge and
              nobody finds out why. */}
          <p
            className={`text-[11px] font-medium normal-case tracking-normal ${
              isUnknownUser
                ? "text-amber-700 dark:text-amber-300"
                : "text-ink-500 dark:text-slate-400"
            }`}
            id="slurm-lab-slurm-user-hint"
          >
            {isUnknownUser
              ? `"${values.slurmUser.trim()}" is not in the configured member list.`
              : "Cluster login username"}
          </p>
        </label>

        <label className={labelClass}>
          Cluster
          <select
            className={inputClass}
            onChange={(event) => {
              const cluster = event.target.value as UsageReportCluster;
              // Select a valid pool when changing clusters.
              setValues((current) => ({
                ...current,
                cluster,
                resourcePool: defaultPoolFor(cluster),
              }));
            }}
            value={values.cluster}
          >
            {clusterOptions.map((cluster) => (
              <option key={cluster} value={cluster}>
                {cluster}
              </option>
            ))}
          </select>
        </label>

        <label className={labelClass}>
          Pool
          <select
            className={inputClass}
            disabled={pools.length < 2}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                resourcePool: event.target.value,
              }))
            }
            value={values.resourcePool}
          >
            {pools.map((pool) => (
              <option key={pool.key} value={pool.key}>
                {pool.label} ({pool.capacity})
              </option>
            ))}
          </select>
          {/* Keep usage and reservations scoped to their cluster and pool. */}
          <p className="text-[11px] font-medium normal-case tracking-normal text-ink-500 dark:text-slate-400">
            {pools.length > 1
              ? "Separate quotas; booking one does not use the other."
              : "This cluster has a single GPU budget."}
          </p>
        </label>

        <label className={labelClass}>
          GPUs
          <input
            className={inputClass}
            inputMode="numeric"
            maxLength={3}
            onBlur={() => {
              const gpuCount = clampCount(gpuInput, 256);
              setGpuInput(String(gpuCount));
              setValues((current) => ({ ...current, gpuCount }));
            }}
            onChange={(event) => {
              const next = sanitizeCount(event.target.value, 3);
              setGpuInput(next);
              setValues((current) => ({
                ...current,
                gpuCount: next === "" ? 0 : Number(next),
              }));
            }}
            type="text"
            value={gpuInput}
          />
        </label>

        <label className={labelClass}>
          Start
          <input
            className={inputClass}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                startTime: event.target.value,
              }))
            }
            required
            step={900}
            type="datetime-local"
            value={values.startTime}
          />
        </label>

        <label className={labelClass}>
          End
          <input
            className={inputClass}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                endTime: event.target.value,
              }))
            }
            max={latestEnd}
            required
            step={900}
            type="datetime-local"
            value={values.endTime}
          />
        </label>

        <label className={`${labelClass} sm:col-span-2`}>
          Note
          <input
            className={inputClass}
            maxLength={200}
            onChange={(event) =>
              setValues((current) => ({
                ...current,
                reason: event.target.value,
              }))
            }
            placeholder="optional"
            value={values.reason}
          />
        </label>
      </div>

      {conflict ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-200">
          Only {conflict.availableGpus} of {values.cluster}'s{" "}
          {conflict.capacity} GPUs are free between{" "}
          {formatShortDateTime(conflict.peakStart)} and{" "}
          {formatShortDateTime(conflict.peakEnd)}
          {conflict.contributors.length > 0 ? (
            <>
              {", "}
              {conflict.contributors
                .map((entry) => `${entry.user} ${entry.gpuCount}`)
                .join(", ")}{" "}
              already booked
            </>
          ) : null}
          . Ask for {conflict.availableGpus} or fewer, or move the window.
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium text-ink-500 dark:text-slate-400">
          {isWindowValid ? (
            <>
              {durationHours} h · {values.gpuCount * durationHours} GPU-hours
            </>
          ) : isTooLong ? (
            <span className="text-red-600 dark:text-red-400">
              {Math.round(durationHours / 24)} days is over the {MAX_BOOKING_HOURS / 24}-day
              limit.
            </span>
          ) : (
            <span className="text-red-600 dark:text-red-400">
              End must be at least 15 min after start
            </span>
          )}
        </p>
        <button
          className="inline-flex h-10 items-center rounded-lg bg-emerald-600 px-5 text-sm font-semibold text-white transition hover:bg-emerald-700 focus:outline-none focus:ring-4 focus:ring-emerald-100 disabled:opacity-60 dark:focus:ring-emerald-900/50"
          disabled={
            isSaving || !isWindowValid || isUnknownUser || Boolean(conflict)
          }
          type="submit"
        >
          {isSaving ? "Saving" : editingId ? "Update" : "Book"}
        </button>
      </div>
    </form>
  );

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-card dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-wrap items-baseline gap-3">
          <h2 className="text-xl font-semibold text-ink-950 dark:text-white">
            Reservations
          </h2>
          {active.length > 0 ? (
            <span className="text-sm font-medium text-ink-500 dark:text-slate-400">
              {activeGpus} GPUs active
            </span>
          ) : null}
        </div>

        {isSignedIn ? null : (
          <button
            className="inline-flex h-10 shrink-0 items-center rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-60 dark:bg-white dark:text-slate-950 dark:hover:bg-slate-200"
            disabled={authLoading}
            onClick={onSignIn}
            type="button"
          >
            Sign in with Google
          </button>
        )}
      </div>

      {error ? (
        <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-900/70 dark:bg-red-950/50 dark:text-red-200">
          {error}
        </p>
      ) : null}

      {/* Keep usage and reservations scoped to their cluster and pool. */}
      {clusterOptions.map((cluster) => {
        const rows = [...active, ...upcoming].filter(
          (report) => report.cluster === cluster,
        );
        const runningNow = active.filter((report) => report.cluster === cluster);
        const gpus = runningNow.reduce((sum, r) => sum + r.gpuCount, 0);
        const isBookingHere = isFormOpen && values.cluster === cluster;

        return (
          <div className="mt-5" key={cluster}>
            <div className="flex items-center justify-between gap-3 border-b border-slate-200 pb-2 dark:border-slate-800">
              <div className="flex items-baseline gap-2">
                <h3 className="text-base font-semibold text-ink-950 dark:text-white">
                  {cluster}
                </h3>
                <span className="text-xs font-medium text-ink-500 dark:text-slate-400">
                  {runningNow.length > 0
                    ? `${gpus} GPU${gpus === 1 ? "" : "s"} active`
                    : "nothing running"}
                </span>
              </div>

              {isSignedIn ? (
                <button
                  className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-ink-700 transition hover:bg-cloud-50 focus:outline-none focus:ring-4 focus:ring-emerald-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 dark:focus:ring-emerald-900/50"
                  onClick={() =>
                    isBookingHere ? closeForm() : openForm(cluster)
                  }
                  type="button"
                >
                  {isBookingHere ? (
                    <X aria-hidden="true" className="h-3.5 w-3.5" />
                  ) : (
                    <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                  )}
                  {isBookingHere ? "Cancel" : "New"}
                </button>
              ) : null}
            </div>

            {isBookingHere ? renderForm() : null}

            {rows.length === 0 ? (
              <p className="mt-3 rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm font-medium text-ink-500 dark:border-slate-700 dark:text-slate-400">
                No reservations
              </p>
            ) : (
              <ul className="mt-3 grid grid-cols-1 gap-2">
                {rows.map((report) => (
                  <ReservationRow
                    canEdit={isSignedIn}
                    bookedNowGpus={
                      bookedNowGpus[
                        usageKey(report.cluster, report.slurmUser || report.userName, report.resourcePool)
                      ] ?? 0
                    }
                    key={report.id}
                    liveGpus={
                      report.slurmUser
                        ? (liveGpusByUser[
                            usageKey(report.cluster, report.slurmUser, report.resourcePool)
                          ] ?? null)
                        : null
                    }
                    now={now}
                    onDelete={handleDelete}
                    onEdit={handleEdit}
                    report={report}
                  />
                ))}
              </ul>
            )}
          </div>
        );
      })}

    </section>
  );
}
