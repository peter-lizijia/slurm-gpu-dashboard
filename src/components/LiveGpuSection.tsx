import { isDemo } from "../config";
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  Cpu,
  RefreshCw,
  Server,
} from "lucide-react";
import type {
  LiveAccountUsage,
  LiveClusterState,
  LiveGpuNode,
  LiveJob,
  LiveQuotaPool,
  LiveReservation,
} from "../types/live";
import type { UsageReport } from "../types/usageReport";

interface LiveGpuSectionProps {
  clusterName: string;
  isRefreshing: boolean;
  /** Every reservation on the board; this section picks out its own cluster's. */
  reservations: UsageReport[];
  state: LiveClusterState;
  onRefresh: () => void;
}

/**
 * GPUs an unbooked account has to be running before the board mentions it.
 *
 * One or two cards is usually a debug run or an interactive session, and
 * demanding a reservation for those makes the notice permanent furniture --
 * which is how a notice stops being read. Above that it is real work that
 * someone else could be planning around.
 */
const UNBOOKED_HINT_MIN_GPUS = 2;

/**
 * A fixed palette indexed by a hash of the username, so one person keeps one
 * colour across the job list and the node map. Reds, oranges and ambers are
 * deliberately absent: those read as alarms here, and amber already marks a
 * job blocked by the account cap. Class strings are spelled out in full
 * because Tailwind only keeps classes it can see verbatim in the source.
 */
const USER_TONES = [
  "bg-sky-100 text-sky-800 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800",
  "bg-violet-100 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-800",
  "bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-800",
  "bg-fuchsia-100 text-fuchsia-800 ring-fuchsia-200 dark:bg-fuchsia-950 dark:text-fuchsia-300 dark:ring-fuchsia-800",
  "bg-cyan-100 text-cyan-800 ring-cyan-200 dark:bg-cyan-950 dark:text-cyan-300 dark:ring-cyan-800",
  "bg-indigo-100 text-indigo-800 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-800",
  "bg-lime-100 text-lime-800 ring-lime-200 dark:bg-lime-950 dark:text-lime-300 dark:ring-lime-800",
  "bg-purple-100 text-purple-800 ring-purple-200 dark:bg-purple-950 dark:text-purple-300 dark:ring-purple-800",
  "bg-teal-100 text-teal-800 ring-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:ring-teal-800",
  "bg-blue-100 text-blue-800 ring-blue-200 dark:bg-blue-950 dark:text-blue-300 dark:ring-blue-800",
  "bg-green-100 text-green-800 ring-green-200 dark:bg-green-950 dark:text-green-300 dark:ring-green-800",
];

/* Compare each GPU pool independently. */
function buildUserTones(names: Iterable<string>): Record<string, number> {
  const tones: Record<string, number> = {};
  [...new Set(names)].sort().forEach((name, index) => {
    tones[name] = index % USER_TONES.length;
  });
  return tones;
}

function UserPill({ name, tone }: { name: string; tone: number }) {
  return (
    <span
      className={`inline-flex w-fit max-w-full items-center truncate rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
        USER_TONES[tone % USER_TONES.length]
      }`}
    >
      {name}
    </span>
  );
}

/** Expand a Slurm GPU index list ("0-3,6") into the set of busy GPU ordinals. */
function parseGpuIndices(idx: string | null): Set<number> {
  const busy = new Set<number>();
  if (!idx) {
    return busy;
  }

  for (const part of idx.split(",")) {
    const range = part.trim();
    if (!range) {
      continue;
    }

    const [startText, endText] = range.split("-");
    const start = Number.parseInt(startText, 10);
    if (Number.isNaN(start)) {
      continue;
    }

    const end = endText === undefined ? start : Number.parseInt(endText, 10);
    for (let value = start; value <= (Number.isNaN(end) ? start : end); value += 1) {
      busy.add(value);
    }
  }

  return busy;
}

/** Slurm durations arrive as "MM:SS", "HH:MM:SS" or "D-HH:MM:SS". */
function parseSlurmSeconds(value: string): number | null {
  if (!value || value === "UNLIMITED" || value === "N/A") {
    return null;
  }

  const [dayPart, timePart] = value.includes("-")
    ? value.split("-")
    : [null, value];
  const days = dayPart ? Number(dayPart) : 0;
  const bits = timePart.split(":").map(Number);

  let hours = 0;
  let minutes = 0;
  let seconds = 0;

  if (bits.length === 3) {
    [hours, minutes, seconds] = bits;
  } else if (bits.length === 2) {
    [minutes, seconds] = bits;
  } else {
    return null;
  }

  if ([days, hours, minutes, seconds].some((part) => !Number.isFinite(part))) {
    return null;
  }

  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function formatCompactDuration(seconds: number): string {
  if (seconds >= 86400) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (seconds >= 3600) {
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function formatAge(seconds: number): string {
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)} min ago`;
  }
  return `${Math.round(seconds / 3600)} hr ago`;
}

/**
 * `count` is the row's total GPU demand. On a folded array job that is the
 * per-task figure times the task count, so the breakdown is spelled out
 * underneath -- otherwise a single queued row reading "40 gpu" against a
 * 8-GPU cluster looks like a bug rather than a backlog.
 */
function GpuBadge({ count, tasks = 1 }: { count: number; tasks?: number }) {
  if (count === 0) {
    return (
      <span className="text-sm font-medium text-slate-400 dark:text-slate-600">
        —
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col">
      <span className="inline-flex items-baseline gap-1">
        <span className="text-base font-semibold tabular-nums text-ink-950 dark:text-white">
          {count}
        </span>
        <span className="text-[11px] font-medium uppercase text-ink-500 dark:text-slate-400">
          gpu
        </span>
      </span>
      {tasks > 1 ? (
        <span className="text-[10px] font-medium tabular-nums text-ink-500 dark:text-slate-500">
          {tasks} × {count / tasks}
        </span>
      ) : null}
    </span>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-medium text-ink-700 dark:bg-slate-800 dark:text-slate-300">
      {children}
    </span>
  );
}

function RunningJobRow({ job, tone }: { job: LiveJob; tone: number }) {
  const used = parseSlurmSeconds(job.timeUsed);
  const limit = parseSlurmSeconds(job.timeLimit);
  const progress =
    used !== null && limit !== null && limit > 0
      ? Math.min(100, (used / limit) * 100)
      : null;

  return (
    <li className="grid grid-cols-[7rem_5rem_minmax(9rem,1fr)_8rem_6.5rem] items-center gap-x-4 px-4 py-3">
      <UserPill name={job.user} tone={tone} />

      <GpuBadge count={job.gpus} />

      <span className="min-w-0">
        <Tag>{job.nodeList ?? "-"}</Tag>
      </span>

      <span className="truncate text-xs font-medium text-ink-500 dark:text-slate-400">
        {job.partition}
      </span>

      <span className="flex flex-col items-end gap-1">
        <span className="font-mono text-xs font-medium text-ink-700 dark:text-slate-300">
          {used !== null ? formatCompactDuration(used) : job.timeUsed}
          {limit !== null ? (
            <span className="text-ink-500 dark:text-slate-500">
              {" / "}
              {formatCompactDuration(limit)}
            </span>
          ) : null}
        </span>
        {progress !== null ? (
          <span className="block h-1 w-28 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <span
              className={`block h-full rounded-full ${
                progress > 90 ? "bg-amber-500" : "bg-emerald-500 dark:bg-emerald-400"
              }`}
              style={{ width: `${progress}%` }}
            />
          </span>
        ) : null}
      </span>
    </li>
  );
}

function QueuedJobRow({ job, tone }: { job: LiveJob; tone: number }) {
  const limit = parseSlurmSeconds(job.timeLimit);
  // The account cap is the lab's own ceiling; every other reason is a cluster
  // or user-side condition. Colouring them apart keeps that distinction visible.
  const isCapped = job.reason === "MaxGRESPerAccount";

  return (
    <li className="grid grid-cols-[7rem_5rem_minmax(9rem,1fr)_8rem_6.5rem] items-center gap-x-4 px-4 py-3">
      <UserPill name={job.user} tone={tone} />

      <GpuBadge count={job.gpus} tasks={job.arrayTasks ?? 1} />

      <span className="min-w-0">
      {job.reason ? (
        <span
          className={`inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-medium ${
            isCapped
              ? "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-800"
              : "bg-slate-100 text-ink-500 dark:bg-slate-800 dark:text-slate-400"
          }`}
        >
          {job.reason}
        </span>
      ) : null}
      </span>

      <span className="truncate text-xs font-medium text-ink-500 dark:text-slate-400">
        {job.partition}
      </span>

      <span className="text-right font-mono text-xs font-medium text-ink-500 dark:text-slate-500">
        {limit !== null ? `limit ${formatCompactDuration(limit)}` : job.timeLimit}
      </span>
    </li>
  );
}

function JobPanel({
  children,
  count,
  footer,
  title,
}: {
  children: ReactNode;
  count: number;
  footer?: ReactNode;
  title: string;
}) {
  if (count === 0) {
    return null;
  }

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex items-baseline gap-2 border-b border-slate-200 bg-cloud-50 px-4 py-2 dark:border-slate-800 dark:bg-slate-950">
        <span className="text-sm font-semibold uppercase tracking-wide text-ink-500 dark:text-slate-400">
          {title}
        </span>
        <span className="text-sm font-semibold text-ink-950 dark:text-white">
          {count}
        </span>
      </div>
      <div className="overflow-x-auto">
        <ul className="min-w-[44rem] divide-y divide-slate-100 bg-white dark:divide-slate-800 dark:bg-slate-900">
          {children}
        </ul>
      </div>
      {footer}
    </div>
  );
}

/**
 * "2026-09-15T06:36:51" -> "Sep 15 06:36". Slurm prints cluster-local time
 * with no zone, so this deliberately never goes through Date(): parsing it as
 * UTC would shift every reservation by the viewer's offset.
 */
function formatSlurmTime(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) {
    return value;
  }
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const month = months[Number(match[2]) - 1] ?? match[2];
  return `${month} ${Number(match[3])} ${match[4]}:${match[5]}`;
}

function NodeGpuRow({ node }: { node: LiveGpuNode }) {
  const busy = parseGpuIndices(node.gpuIdx);
  const isDown = node.offline;
  const free = node.gpuFree ?? Math.max(0, node.gpuTotal - node.gpuUsed);
  // "Open" is what a new lab job could land on right now. Idle GPUs inside
  // someone else's reservation or promised to a queued job are painted as in
  // use: from the lab's point of view they are.
  const open = node.gpuSchedulable ?? (isDown ? 0 : free);
  const held = Math.max(0, free - open);
  const reservation = node.reservation ?? null;
  const plan = node.plannedFor ?? null;

  // The detail lives in a tooltip so the map itself stays two colours.
  const notes: string[] = [];
  if (reservation && (node.gpuReserved ?? 0) > 0) {
    notes.push(
      `${node.gpuReserved} idle in reservation ${reservation.name ?? ""}${
        reservation.ours ? ` (lab: sbatch --reservation=${reservation.name})` : ""
      }${reservation.endTime ? ` until ${formatSlurmTime(reservation.endTime)}` : ""}`,
    );
  }
  if ((node.gpuPlanned ?? 0) > 0) {
    notes.push(
      `${node.gpuPlanned} idle promised to queued job${(node.plannedJobs ?? 1) === 1 ? "" : "s"}${
        plan?.startTime ? ` starting ${formatSlurmTime(plan.startTime)}` : ""
      }`,
    );
  }
  if (open > 0 && node.openUntil) {
    notes.push(`open until ${formatSlurmTime(node.openUntil)}`);
  }
  if (node.rebootPending) {
    notes.push("reboot pending: jobs still start here, node reboots once idle");
  }
  const tooltip = notes.length > 0 ? `${node.node}: ${notes.join(" · ")}` : node.node;

  let idleSeen = 0;

  return (
    <div className="flex items-center gap-3 py-1.5" title={tooltip}>
      <span className="w-20 shrink-0 font-mono text-xs font-semibold text-ink-700 dark:text-slate-300">
        {node.node}
      </span>

      {/* A fixed eight-column grid rather than free-flowing wrap: MIG nodes
          carry 16 or 32 slices, and an unconstrained row runs off the panel.
          Eight per row also matches the physical layout of a DGX box. */}
      <div className="grid w-fit shrink-0 grid-cols-8 gap-1">
        {Array.from({ length: node.gpuTotal }, (_, index) => {
          // Fall back to a count-based fill when Slurm reports no index list.
          const isBusy = node.gpuIdx ? busy.has(index) : index < node.gpuUsed;
          // Slurm does not say which idle GPU is held, only how many, so the
          // idle squares are painted in order: held first, then open.
          const isHeld = !isDown && !isBusy && idleSeen++ < held;
          // Red for offline. Grey read as "free", which made a drained node
          // look like available capacity -- the opposite of the truth.
          const tone = isDown
            ? "bg-rose-400 dark:bg-rose-600"
            : isBusy || isHeld
              ? "bg-emerald-500 dark:bg-emerald-400"
              : "bg-slate-200 dark:bg-slate-800";
          const label = isDown
            ? node.state
            : isBusy
              ? "allocated"
              : isHeld
                ? "idle but not available (reserved or promised)"
                : "open";

          return (
            <span
              className={`h-4 w-4 rounded-sm ring-1 ring-inset ring-black/5 dark:ring-white/10 ${tone}`}
              key={index}
              title={`${node.node} GPU ${index}: ${label}`}
            />
          );
        })}
      </div>

      <span
        className={`ml-auto shrink-0 text-right text-xs font-medium tabular-nums ${
          isDown
            ? "text-rose-600 dark:text-rose-400"
            : open > 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-ink-500 dark:text-slate-400"
        }`}
      >
        {isDown ? node.state : `${open}/${node.gpuTotal} open`}
      </span>
    </div>
  );
}

/** Accounts listed before "show all": the heavy hitters, plus the lab's place. */
const ACCOUNT_ROWS_COLLAPSED = 10;

/* Compare each GPU pool independently. */
function AccountUsagePanel({
  clusterGpuUsed,
  partitions,
  pools,
  rows,
}: {
  clusterGpuUsed: number;
  partitions: string[];
  pools: LiveQuotaPool[];
  rows: LiveAccountUsage[];
}) {
  const [showAll, setShowAll] = useState(false);
  const top = rows[0]?.gpusUsed ?? 0;
  const running = rows.reduce((sum, row) => sum + row.gpusUsed, 0);
  // squeue and sinfo are read moments apart, and a COMPLETING job still holds
  // cards sinfo counts, so the two totals can differ by a few GPUs.
  const allocated = Math.max(clusterGpuUsed, running);
  const poolLabels = new Map(pools.map((pool) => [pool.key, pool.label]));
  const showPools = pools.length > 1;
  const labIndex = rows.findIndex((row) => row.ours);
  const visible = showAll ? rows : rows.slice(0, ACCOUNT_ROWS_COLLAPSED);
  const labBelowFold = !showAll && labIndex >= ACCOUNT_ROWS_COLLAPSED;
  // Spelled out in full: Tailwind only keeps classes it sees verbatim.
  const gridClass = showPools
    ? "grid-cols-[1.75rem_minmax(11rem,15rem)_minmax(11rem,1fr)_minmax(9rem,13rem)_4.5rem_3.5rem_3.5rem]"
    : "grid-cols-[1.75rem_minmax(11rem,15rem)_minmax(11rem,1fr)_4.5rem_3.5rem_3.5rem]";

  const renderRow = (row: LiveAccountUsage, index: number) => {
    const share = allocated > 0 ? Math.round((row.gpusUsed / allocated) * 100) : 0;
    const width = top > 0 ? (row.gpusUsed / top) * 100 : 0;
    const poolText = Object.entries(row.byPool)
      .filter(([, gpus]) => gpus > 0)
      .sort(([, a], [, b]) => b - a)
      .map(([key, gpus]) => `${gpus} ${poolLabels.get(key) ?? key}`)
      .join(" · ");

    return (
      <li
        className={`grid ${gridClass} items-center gap-x-4 px-4 py-2.5 ${
          row.ours ? "bg-emerald-50/60 dark:bg-emerald-950/30" : ""
        }`}
        key={row.account}
      >
        <span className="text-xs font-semibold tabular-nums text-ink-500 dark:text-slate-500">
          {index + 1}
        </span>

        <span className="flex min-w-0 items-center gap-2">
          <span
            className="truncate font-mono text-xs font-semibold text-ink-700 dark:text-slate-200"
            title={row.account}
          >
            {row.account}
          </span>
          {row.ours ? (
            <span className="shrink-0 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-800 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-800">
              lab
            </span>
          ) : null}
        </span>

        <span className="flex items-center gap-3">
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
            <span
              className={`block h-full rounded-full ${
                row.ours
                  ? "bg-emerald-500 dark:bg-emerald-400"
                  : "bg-sky-500 dark:bg-sky-400"
              }`}
              style={{ width: `${width}%` }}
            />
          </span>
          <span className="w-16 shrink-0 text-right">
            <span className="text-sm font-semibold tabular-nums text-ink-950 dark:text-white">
              {row.gpusUsed}
            </span>
            <span className="ml-1 text-[11px] font-medium tabular-nums text-ink-500 dark:text-slate-400">
              {share}%
            </span>
          </span>
        </span>

        {showPools ? (
          <span
            className="truncate text-xs font-medium text-ink-500 dark:text-slate-400"
            title={poolText}
          >
            {poolText || "—"}
          </span>
        ) : null}

        <span className="text-right text-xs font-medium tabular-nums text-ink-500 dark:text-slate-400">
          {row.gpusPending > 0 ? row.gpusPending : "—"}
        </span>
        <span className="text-right text-xs font-medium tabular-nums text-ink-500 dark:text-slate-400">
          {row.runningJobs}
        </span>
        <span className="text-right text-xs font-medium tabular-nums text-ink-500 dark:text-slate-400">
          {row.users}
        </span>
      </li>
    );
  };

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="overflow-x-auto">
        <div className="min-w-[52rem] bg-white dark:bg-slate-900">
          <div
            className={`grid ${gridClass} gap-x-4 border-b border-slate-200 bg-cloud-50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400`}
          >
            <span>#</span>
            <span>Group (Slurm account)</span>
            <span>GPUs running · share</span>
            {showPools ? <span>By pool</span> : null}
            <span className="text-right">Queued</span>
            <span className="text-right">Jobs</span>
            <span
              className="text-right"
              title="Distinct users with a GPU job running or queued"
            >
              Users
            </span>
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {visible.map(renderRow)}
            {labBelowFold ? (
              <>
                <li className="px-4 py-1 text-center text-[11px] font-medium text-ink-500 dark:text-slate-500">
                  ⋯
                </li>
                {renderRow(rows[labIndex], labIndex)}
              </>
            ) : null}
          </ul>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-cloud-50 px-4 py-2.5 text-xs font-medium text-ink-500 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
        <span>
          {rows.length} groups hold {running} of {allocated} allocated GPUs on{" "}
          {partitions.join(", ")}. Counts only; usernames outside the lab are not
          published.
        </span>
        {rows.length > ACCOUNT_ROWS_COLLAPSED ? (
          <button
            className="font-semibold text-emerald-700 hover:underline dark:text-emerald-300"
            onClick={() => setShowAll((current) => !current)}
            type="button"
          >
            {showAll
              ? `Show top ${ACCOUNT_ROWS_COLLAPSED}`
              : `Show all ${rows.length}`}
          </button>
        ) : null}
      </div>
    </div>
  );
}

function LiveStat({
  hint,
  icon: Icon,
  label,
  tone = "normal",
  value,
}: {
  hint: string;
  icon: typeof Activity;
  label: string;
  tone?: "normal" | "warn";
  value: string | number;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        tone === "warn"
          ? "border-amber-200 bg-amber-50 dark:border-amber-900/70 dark:bg-amber-950/40"
          : "border-slate-200 bg-cloud-50 dark:border-slate-800 dark:bg-slate-950"
      }`}
    >
      <div className="flex items-center gap-2 text-ink-500 dark:text-slate-400">
        <Icon aria-hidden="true" className="h-4 w-4" />
        <p className="text-xs font-semibold uppercase tracking-wide">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-semibold text-ink-950 dark:text-white">
        {value}
      </p>
      <p className="mt-1 text-xs font-medium text-ink-500 dark:text-slate-400">
        {hint}
      </p>
    </div>
  );
}

export function LiveGpuSection({
  clusterName,
  isRefreshing,
  reservations,
  state,
  onRefresh,
}: LiveGpuSectionProps) {
  const [showNodes, setShowNodes] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const { payload, ageSeconds, isStale } = state;
  const { summary } = payload;

  const running = useMemo(
    () => payload.jobs.filter((job) => job.state.toUpperCase() === "RUNNING"),
    [payload.jobs],
  );
  const pending = useMemo(
    () => payload.jobs.filter((job) => job.state.toUpperCase() === "PENDING"),
    [payload.jobs],
  );

  const userTones = useMemo(
    () => buildUserTones(payload.jobs.map((job) => job.user)),
    [payload.jobs],
  );

  /**
   * Accounts running more than a couple of GPUs here with no reservation
   * covering right now.
   *
   * Only bookings already under way count: one that starts this afternoon does
   * not cover a job running this morning. Matching is on `slurmUser`, which is
   * the only field that can equal a Slurm account name -- a booking saved
   * without one simply cannot vouch for anybody, so it is skipped rather than
   * silently matching on a display name.
   */
  /* Compare each GPU pool independently. */
  const poolOfPartition = useMemo(() => {
    const byPartition = new Map<string, string>();
    for (const pool of summary.pools ?? []) {
      for (const partition of pool.partitions) {
        byPartition.set(partition, pool.key);
      }
    }
    const catchAll =
      (summary.pools ?? []).find((pool) => pool.partitions.length === 0)?.key ??
      "default";
    return (partition: string) => byPartition.get(partition) ?? catchAll;
  }, [summary.pools]);

  /* Compare each GPU pool independently. */
  const unbookedUsers = useMemo(() => {
    const now = Date.now();
    const poolLabels = new Map(
      (summary.pools ?? []).map((pool) => [pool.key, pool.label]),
    );

    const booked = new Set(
      reservations
        .filter(
          (report) =>
            report.cluster === clusterName &&
            report.slurmUser &&
            new Date(report.startTime).getTime() <= now &&
            now < new Date(report.endTime).getTime(),
        )
        .map((report) => `${report.resourcePool}\u0000${report.slurmUser}`),
    );

    const gpusByUserPool: Record<string, number> = {};
    for (const job of running) {
      const key = `${poolOfPartition(job.partition)}\u0000${job.user}`;
      gpusByUserPool[key] = (gpusByUserPool[key] ?? 0) + job.gpus;
    }

    return Object.entries(gpusByUserPool)
      .filter(([key, gpus]) => gpus > UNBOOKED_HINT_MIN_GPUS && !booked.has(key))
      .map(([key, gpus]) => {
        const [pool, user] = key.split("\u0000");
        // Only name the pool where there is more than one to confuse.
        const label =
          (summary.pools ?? []).length > 1 ? poolLabels.get(pool) ?? null : null;
        return { user, gpus, pool: label };
      })
      // Biggest unbooked footprint first.
      .sort((a, b) => b.gpus - a.gpus || a.user.localeCompare(b.user));
  }, [clusterName, poolOfPartition, reservations, running, summary.pools]);

  // Cluster-wide GPU demand per Slurm account. One row says nothing about
  // needs at least two to appear.
  const accountRows = payload.byAccount ?? [];
  const labAccountIndex = accountRows.findIndex((row) => row.ours);
  const labAccount = labAccountIndex >= 0 ? accountRows[labAccountIndex] : null;

  /* Compare each GPU pool independently. */
  const visiblePools = useMemo(() => {
    const pools = summary.pools ?? [];
    if (pools.length === 1 && pools[0].totalGpus === summary.clusterGpuTotal) {
      return [];
    }
    return pools;
  }, [summary.pools, summary.clusterGpuTotal]);

  // GPUs a new lab job could land on right now. Everything else -- allocated,
  // reserved for another group, promised to a queued job -- reads as in use:
  // from the lab's point of view it is. Older payloads only know allocated.
  const openGpus = summary.clusterGpuSchedulable;
  const unavailableGpus =
    openGpus === undefined
      ? summary.clusterGpuUsed
      : summary.clusterGpuTotal - openGpus;
  // Slurm reservations, not lab bookings (those are the `reservations` prop).
  const slurmReservations: LiveReservation[] = summary.reservations ?? [];
  // Someone else's ACTIVE reservation on a watched node: its idle GPUs look
  // free on the map but no lab job can land there.
  const activeForeignReservations = slurmReservations.filter(
    (reservation) =>
      reservation.state === "ACTIVE" && !(reservation.ours && reservation.magnetic),
  );
  // A maintenance window that has not started yet still blocks: Slurm will
  // not start a job whose time limit runs into it.
  const upcomingMaintenance = slurmReservations.filter(
    (reservation) => reservation.maintenance && reservation.state !== "ACTIVE",
  );
  const tileCount = visiblePools.length + 1;
  const tileGridClass =
    tileCount >= 4
      ? "sm:grid-cols-2 lg:grid-cols-4"
      : tileCount === 3
        ? "sm:grid-cols-2 lg:grid-cols-3"
        : tileCount === 2
          ? "sm:grid-cols-2"
          : "";

  const capacity = summary.totalGpus ?? 0;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-card dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-slate-900 text-white ring-1 ring-slate-900 dark:bg-slate-800 dark:ring-slate-700">
            <Activity aria-hidden="true" className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-ink-950 dark:text-white">
              Live GPU · {clusterName}
            </h2>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-500 dark:text-slate-400">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold ${
                  isStale
                    ? "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300"
                    : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300"
                }`}
              >
                <span
                  className={`h-2 w-2 rounded-full ${
                    isStale ? "bg-amber-500" : "animate-pulse bg-emerald-500"
                  }`}
                />
                {isDemo ? "Sample" : isStale ? "Agent stalled" : "Live"}
              </span>
              <span>updated {formatAge(ageSeconds)}</span>
            </p>
          </div>
        </div>

        <button
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-ink-700 transition hover:bg-cloud-50 focus:outline-none focus:ring-4 focus:ring-emerald-100 disabled:opacity-60 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700 dark:focus:ring-emerald-900/50"
          disabled={isRefreshing}
          onClick={onRefresh}
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`}
          />
          Refresh
        </button>
      </div>

      {isStale ? (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-200">
          <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            The collection agent last reported {formatAge(ageSeconds)}. Its Slurm
            job may have ended without a successor. Numbers below are the last
            known state, not current.
          </span>
        </p>
      ) : null}

      {upcomingMaintenance.map((reservation) => (
        <p
          className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/50 dark:text-amber-200"
          key={reservation.name}
        >
          <CalendarClock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Maintenance reservation <strong>{reservation.name}</strong> on{" "}
            {reservation.nodeCount} node{reservation.nodeCount === 1 ? "" : "s"}{" "}
            starts {formatSlurmTime(reservation.startTime) ?? "soon"}
            {reservation.endTime
              ? ` and ends ${formatSlurmTime(reservation.endTime)}`
              : ""}
            . A job whose time limit would still be running then will not start
            before it, even with GPUs idle.
          </span>
        </p>
      ))}

      <div className={`mt-5 grid gap-3 ${tileGridClass}`}>
        {/* Compare each GPU pool independently. */}
        {/* Guarded: a payload written by an agent that has not reloaded yet
            carries no pools, and mapping over undefined would blank the page. */}
        {visiblePools.map((pool) => (
          <LiveStat
            icon={Cpu}
            key={pool.key}
            label={pool.label}
            tone={pool.atCap ? "warn" : "normal"}
            value={`${pool.gpusUsed}${pool.totalGpus ? ` / ${pool.totalGpus}` : ""}`}
            hint={`${pool.runningJobs} running${
              pool.gpusPending > 0 ? ` · ${pool.gpusPending} GPUs queued` : ""
            }${pool.atCap ? " · at cap" : ""}${
              pool.gpusStartableNow !== undefined && !pool.atCap
                ? ` · ${pool.gpusStartableNow} startable now`
                : ""
            }`}
          />
        ))}
        <LiveStat
          icon={Server}
          label="Cluster-wide GPUs"
          value={`${unavailableGpus} / ${summary.clusterGpuTotal}`}
          hint={`${
            openGpus === undefined ? "in use" : `${openGpus} available right now`
          } · ${summary.gpuNodes} node${summary.gpuNodes === 1 ? "" : "s"}${
            summary.clusterGpuOffline ? ` · ${summary.clusterGpuOffline} offline` : ""
          }`}
        />
      </div>

      {/* Above the list rather than tucked under it: a reminder nobody scrolls
          to is not a reminder. Amber like the other notices, names in bold. */}
      {unbookedUsers.length > 0 ? (
        <div className="mt-4 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100">
          <CalendarClock aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
          <p>
            <span className="font-semibold">Running without a booking:</span>{" "}
            {unbookedUsers.map((entry, index) => (
              <span key={`${entry.pool ?? ""}\u0000${entry.user}`}>
                {index > 0 ? ", " : ""}
                <strong className="text-base font-bold">{entry.user}</strong>
                <span className="text-amber-800 dark:text-amber-200">
                  {entry.pool
                    ? ` (${entry.gpus} GPUs on ${entry.pool})`
                    : ` (${entry.gpus} GPUs)`}
                </span>
              </span>
            ))}
            . Please reserve a slot in the booking panel above, so others can
            plan around it.
          </p>
        </div>
      ) : null}

      <JobPanel count={running.length} title="Running">
        {running.map((job) => (
          <RunningJobRow job={job} key={job.jobId} tone={userTones[job.user] ?? 0} />
        ))}
      </JobPanel>

      <JobPanel count={pending.length} title="Queued">
        {pending.map((job) => (
          <QueuedJobRow job={job} key={job.jobId} tone={userTones[job.user] ?? 0} />
        ))}
      </JobPanel>

      {accountRows.length >= 2 ? (
        <>
          <button
            aria-expanded={showAccounts}
            className={`mt-4 flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-semibold transition focus:outline-none focus:ring-4 focus:ring-emerald-100 dark:focus:ring-emerald-900/50 ${
              showAccounts
                ? "border-slate-200 bg-white text-ink-700 hover:bg-cloud-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/70"
                : "border-sky-200 bg-sky-50/60 text-ink-700 hover:bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-slate-200 dark:hover:bg-sky-950/50"
            }`}
            onClick={() => setShowAccounts((current) => !current)}
            type="button"
          >
            <ChevronDown
              aria-hidden="true"
              className={`h-4 w-4 shrink-0 text-sky-600 transition-transform duration-200 dark:text-sky-400 ${
                showAccounts ? "rotate-180" : ""
              }`}
            />
            <span className="min-w-0 flex-1">
              {showAccounts ? "Hide" : "Show"} GPU use by group ({accountRows.length}{" "}
              groups)
              {showAccounts ? null : (
                <span className="ml-2 text-xs font-medium text-ink-500 dark:text-slate-400">
                  top:{" "}
                  {accountRows
                    .slice(0, 3)
                    .map((row) => `${row.account} ${row.gpusUsed}`)
                    .join(" · ")}
                  {labAccount
                    ? ` · ${labAccount.account} is #${labAccountIndex + 1} with ${labAccount.gpusUsed}`
                    : ""}
                </span>
              )}
            </span>
          </button>
          {showAccounts ? (
            <AccountUsagePanel
              clusterGpuUsed={summary.clusterGpuUsed}
              partitions={payload.agent.partitions}
              pools={summary.pools ?? []}
              rows={accountRows}
            />
          ) : null}
        </>
      ) : null}

      <button
        aria-expanded={showNodes}
        className={`mt-4 flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm font-semibold transition focus:outline-none focus:ring-4 focus:ring-emerald-100 dark:focus:ring-emerald-900/50 ${
          showNodes
            ? "border-slate-200 bg-white text-ink-700 hover:bg-cloud-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800/70"
            : "border-emerald-200 bg-emerald-50/60 text-ink-700 hover:bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-slate-200 dark:hover:bg-emerald-950/50"
        }`}
        onClick={() => setShowNodes((current) => !current)}
        type="button"
      >
        <ChevronDown
          aria-hidden="true"
          className={`h-4 w-4 shrink-0 text-emerald-600 transition-transform duration-200 dark:text-emerald-400 ${
            showNodes ? "rotate-180" : ""
          }`}
        />
        <span className="min-w-0 flex-1">
          {showNodes ? "Hide" : "Show"} per-node GPU map ({payload.nodes.length} node{payload.nodes.length === 1 ? "" : "s"})

        </span>
      </button>

      {showNodes ? (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="grid gap-x-10 xl:grid-cols-2">
            {payload.nodes.map((node) => (
              <NodeGpuRow key={node.node} node={node} />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-3 text-xs font-medium text-ink-500 dark:border-slate-800 dark:text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-emerald-500 dark:bg-emerald-400" />
              in use, reserved or promised
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-slate-200 dark:bg-slate-800" />
              open
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-rose-400 dark:bg-rose-600" />
              unavailable
            </span>
            <span>hover a row for details</span>
          </div>
          {activeForeignReservations.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs text-ink-500 dark:text-slate-400">
              {activeForeignReservations.map((reservation) => (
                <li key={reservation.name}>
                  <CalendarClock
                    aria-hidden="true"
                    className="mr-1 inline h-3 w-3 text-violet-600 dark:text-violet-400"
                  />
                  <strong className="text-ink-700 dark:text-slate-300">
                    {reservation.name}
                  </strong>{" "}
                  holds {reservation.nodes.join(", ")} for{" "}
                  {reservation.userCount > 0
                    ? `${reservation.userCount} user${reservation.userCount === 1 ? "" : "s"}`
                    : reservation.accounts.length > 0
                      ? reservation.accounts.join(", ")
                      : reservation.groups.length > 0
                        ? `group ${reservation.groups.join(", ")}`
                        : "its members"}
                  {reservation.endTime
                    ? ` until ${formatSlurmTime(reservation.endTime)}`
                    : ""}
                  {reservation.idleGpus > 0
                    ? reservation.ours
                      ? ` · ${reservation.idleGpus} idle GPU${reservation.idleGpus === 1 ? "" : "s"} for the lab, submit with --reservation=${reservation.name}`
                      : ` · ${reservation.idleGpus} idle GPU${reservation.idleGpus === 1 ? "" : "s"} the lab cannot use`
                    : ""}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
