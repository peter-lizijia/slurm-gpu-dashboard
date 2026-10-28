#!/usr/bin/env python3
"""
Live telemetry collector for Slurm GPU Dashboard.

Runs on a cluster node, polls Slurm, and pushes a snapshot to Supabase over
outbound HTTPS. Nothing listens on a port, so this needs no firewall change and
no inbound listener. Follow your cluster\'s rules for monitoring jobs.

    export SUPABASE_URL=https://<ref>.supabase.co
    export SUPABASE_SERVICE_ROLE_KEY=<service_role jwt>
    python3 scripts/live_gpu_agent.py --cluster ATLAS --once --no-push

Standard library only, so it runs with the stock system python3 on any node.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "slurm-gpu-v1"

# Filled from the shared JSON configuration before collection starts.
POOLS_BY_CLUSTER: dict[str, list[dict[str, Any]]] = {}


def pools_for_cluster(cluster: str) -> list[dict[str, Any]]:
    return POOLS_BY_CLUSTER[cluster]


def load_cluster_config(path: str, cluster: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    matches = [item for item in data["clusters"] if item["id"] == cluster]
    if len(matches) != 1:
        raise ValueError(f"Expected exactly one configuration for cluster {cluster!r}")
    config = matches[0]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,48}", cluster):
        raise ValueError("Invalid cluster ID")
    if not config.get("account") or not config.get("pools"):
        raise ValueError("Each cluster needs an account and at least one GPU pool")
    keys, partitions = set(), set()
    for pool in config["pools"]:
        capacity = pool.get("capacity")
        if not pool.get("key") or pool["key"] in keys:
            raise ValueError("Pool keys must be nonempty and unique")
        if not isinstance(capacity, int) or isinstance(capacity, bool) or capacity < 1:
            raise ValueError("Set each pool capacity to a positive, administrator-confirmed GPU limit")
        if not pool.get("partitions") or any(not isinstance(p, str) or not p for p in pool["partitions"]):
            raise ValueError("Each pool needs named partitions")
        if partitions.intersection(pool["partitions"]):
            raise ValueError("A partition cannot be counted in more than one GPU pool")
        keys.add(pool["key"])
        partitions.update(pool["partitions"])
        pool.setdefault("qos", None)
    return config


SINFO_FIELDS = (
    "NodeHost:64,Partition:64,StateLong:32,Gres:96,GresUsed:96,CPUsState:32,Memory:24,"
    # StateLong shows a single suffix glyph and hides the rest: a node that is
    # MIXED+REBOOT_REQUESTED+PLANNED prints as "mixed@", so the backfill hold
    # is invisible. StateComplete lists every flag.
    "StateComplete:96"
)
# Pending jobs with a backfill plan. SchedNodes/StartTime are ordinary squeue
# columns; `squeue --start` is NOT used because it silently discards -O.
# SchedNodes is wide because squeue -O truncates silently, with no marker, and
# a truncated bracket list expands to nothing.
SQUEUE_PLAN_FIELDS = (
    "JobID:24,UserName:32,SchedNodes:1024,StartTime:24,tres-alloc:160,TimeLimit:20,"
    "Partition:32,Reason:48"
)
# A plan whose start is within this window counts as holding the GPUs now: the
# next scheduler cycle will hand them over. Plans further out only bound how
# long a new job could run there.
PLAN_HORIZON_SECONDS = 15 * 60
SQUEUE_FIELDS = (
    "JobID:24,UserName:32,State:16,tres-alloc:160,TimeUsed:20,TimeLimit:20,"
    "NodeList:64,Partition:32,Reason:48,Name:96,ArrayTaskID:64"
)
# Every account's GPU jobs, for the "which group holds the GPUs" table. No -A
# filter, and -a so a hidden partition is not skipped; the agent already reads
# the whole queue for backfill plans, so this needs no new permission. Account
# is wide because squeue truncates silently; multi-partition names need room.
SQUEUE_ACCOUNT_FIELDS = (
    "Account:128,UserName:32,State:16,tres-alloc:160,Partition:128,ArrayTaskID:64"
)

_shutdown = False


def _handle_signal(signum: int, _frame: Any) -> None:
    global _shutdown
    _shutdown = True
    log(f"received signal {signum}, finishing current cycle and exiting")


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    # Full log storage must not prevent database updates.
    try:
        print(f"[{stamp}] {message}", flush=True)
    except OSError:
        pass


def field_widths(spec: str) -> list[int]:
    """Widths declared in a Slurm ``-O`` format spec, e.g. ``JobID:24,...``."""
    return [int(part.rsplit(":", 1)[1]) for part in spec.split(",")]


def slice_fields(line: str, widths: list[int]) -> list[str]:
    """Split one fixed-width Slurm ``-O`` row.

    Splitting on whitespace is not safe here: Slurm pads every column to its
    declared width, so an empty column (NodeList on a PENDING job, Reason on a
    RUNNING one) would silently collapse and shift every later field left.
    """
    values: list[str] = []
    offset = 0
    for width in widths:
        values.append(line[offset : offset + width].strip())
        offset += width
    return values


# --------------------------------------------------------------------------
# Slurm collection
# --------------------------------------------------------------------------


def run_text(command: list[str], timeout: int = 60, required: bool = False) -> str:
    """Optional metadata may fail; required telemetry failures invalidate the cycle."""
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "LC_ALL": "C"},
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        log(f"command failed: {' '.join(command)} -> {error}")
        if required:
            raise RuntimeError(f"Required command failed: {command[0]}") from error
        return ""

    if result.returncode != 0:
        if required:
            raise RuntimeError(f"Required command failed: {command[0]}: {result.stderr.strip()[:200]}")
        log(
            f"command exit {result.returncode}: {' '.join(command)} -> "
            f"{result.stderr.strip()[:200]}"
        )
        return ""

    return result.stdout


def parse_int(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value.strip())
    except (ValueError, AttributeError):
        return None


def gres_gpu_count(text: str | None) -> int:
    """Count GPUs in an sinfo Gres/GresUsed string.

    Handles ``gpu:B200:8(S:0-1)``, ``gpu:B200:0(IDX:N/A)`` and bare ``gpu:4``.
    """
    if not text or text in {"(null)", "N/A", "None", "(none)"}:
        return 0

    # Strip the parenthesised detail BEFORE splitting on commas. A GPU index
    # list contains them -- "gpu:B200:7(IDX:0-1,3-7)" -- so splitting first
    # shreds the token into "gpu:B200:7(IDX:0-1" and "3-7)", and the leading
    # fragment then yields 0 because its last colon-field is "0-1". Nodes whose
    # allocated GPUs happen to be contiguous parsed fine, which is what made
    # this look like a display glitch rather than a counting one.
    cleaned = re.sub(r"\([^)]*\)", "", text)

    total = 0
    for token in re.split(r"[,;\s]+", cleaned):
        if not token.lower().startswith("gpu"):
            continue
        parts = token.split(":")
        if len(parts) < 2:
            continue
        match = re.match(r"(\d+)$", parts[-1])
        if match:
            total += int(match.group(1))

    return total


def gres_gpu_indices(text: str | None) -> str | None:
    """Pull the allocated GPU index list out of a GresUsed string."""
    if not text:
        return None
    match = re.search(r"IDX:([^)]+)", text)
    if not match:
        return None
    value = match.group(1).strip()
    return None if value in {"N/A", ""} else value


def tres_gpu_count(tres: str | None) -> int:
    """Extract the job-total GPU count from a Slurm TRES string.

    ``cpu=6,mem=56G,node=1,billing=250,gres/gpu=1,gres/gpu:45gb=1`` must yield 1,
    not 2 -- the typed ``gres/gpu:45gb`` entry restates the same allocation.
    """
    if not tres:
        return 0
    match = re.search(r"(?:^|,)gres/gpu=(\d+)", tres)
    if match:
        return int(match.group(1))
    return sum(int(value) for value in re.findall(r"(?:^|,)gres/gpu:[^=,]+=(\d+)", tres))


def array_task_count(spec: str | None) -> int:
    """Count the tasks a job row stands for, from its ArrayTaskID field.

    squeue folds an array job's unstarted tasks into a single row and reports
    the *per-task* TRES on it, so "0-9%3" -- ten tasks each asking for one GPU
    -- otherwise counts as a single queued GPU.

    The "%3" suffix is a concurrency throttle, not a task count, and is dropped:
    all ten tasks are queued regardless of how many may run at once.

    A started task appears on its own row with a bare index ("3"), and a
    non-array job reports "N/A"; both are one task.
    """
    if not spec or spec in {"N/A", ""}:
        return 1

    total = 0
    for part in spec.split("%", 1)[0].split(","):
        piece = part.strip()
        if not piece:
            continue
        span, _, step_text = piece.partition(":")
        start_text, separator, end_text = span.partition("-")
        try:
            start = int(start_text)
            end = int(end_text) if separator else start
            step = int(step_text) if step_text else 1
        except ValueError:
            continue
        if end >= start and step > 0:
            total += (end - start) // step + 1

    # An unparseable spec must not erase a job: fall back to counting it once.
    return max(1, total)


def collect_nodes(partitions: list[str]) -> list[dict[str, Any]]:
    command = ["sinfo", "-h", "-N", "-O", SINFO_FIELDS]
    if partitions:
        command.extend(["-p", ",".join(partitions)])

    by_node: dict[str, dict[str, Any]] = {}
    widths = field_widths(SINFO_FIELDS)

    for line in run_text(command, required=True).splitlines():
        if not line.strip():
            continue

        node, partition, state, gres, gres_used, cpu_state, memory, state_full = (
            slice_fields(line, widths)
        )
        if not node:
            continue
        gpu_total = gres_gpu_count(gres)
        if gpu_total == 0:
            continue

        cpu_parts = cpu_state.split("/")
        flags = [flag for flag in state_full.lower().split("+") if flag]
        entry = by_node.setdefault(
            node,
            {
                "node": node,
                "partitions": [],
                "state": state,
                # A drained or unreachable node's GPUs cannot be scheduled, so
                # they are not capacity. Slurm suffixes an unreachable node's
                # state with "*" when it is not responding.
                "offline": bool(re.search(r"down|drain|fail|maint|unk|\*", state, re.I)),
                "flags": flags,
                # Backfill has promised this node to a queued job it could not
                # start yet; only work that finishes before that job's planned
                # start can use the idle GPUs. Slurm's sinfo suffix is "-".
                "planned": "planned" in flags,
                # `scontrol reboot` without ASAP: the node reboots once it
                # drains. Verified NOT to block new jobs (starts observed on
                # "@" nodes), but they will go away for a while at some point.
                "rebootPending": any(f.startswith("reboot") for f in flags),
                "gpuTotal": gpu_total,
                "gpuUsed": gres_gpu_count(gres_used),
                "gpuIdx": gres_gpu_indices(gres_used),
                "cpuAllocated": parse_int(cpu_parts[0]) if cpu_parts else None,
                "cpuTotal": parse_int(cpu_parts[3]) if len(cpu_parts) > 3 else None,
                "memoryMb": parse_int(memory),
            },
        )
        if partition not in entry["partitions"]:
            entry["partitions"].append(partition)

    return sorted(by_node.values(), key=lambda item: item["node"])


_NULLISH = {"", "(null)", "N/A", "n/a", "None", "(none)"}


def expand_hostlist(text: str) -> list[str]:
    """Expand a Slurm hostlist such as ``gpu[001-003,010],gpu028``.

    Handles one bracket group per comma-separated part with zero-padded
    numeric ranges, which covers every list this cluster prints. Anything more
    exotic raises ValueError so the caller can fall back to
    ``scontrol show hostnames`` instead of silently dropping nodes.
    """
    if text in _NULLISH:
        return []

    parts: list[str] = []
    depth = 0
    token = ""
    for char in text:
        if char == "[":
            depth += 1
        elif char == "]":
            depth -= 1
        if char == "," and depth == 0:
            parts.append(token)
            token = ""
        else:
            token += char
    parts.append(token)

    hosts: list[str] = []
    for part in parts:
        part = part.strip()
        if not part:
            continue
        match = re.fullmatch(r"([^\[\]]*)\[([^\]]+)\]([^\[\]]*)", part)
        if not match:
            if "[" in part or "]" in part:
                raise ValueError(f"unsupported hostlist: {part}")
            hosts.append(part)
            continue
        prefix, ranges, suffix = match.groups()
        for item in ranges.split(","):
            start_text, separator, end_text = item.partition("-")
            if not start_text.isdigit() or (separator and not end_text.isdigit()):
                raise ValueError(f"unsupported hostlist range: {part}")
            width = len(start_text)
            end = int(end_text) if separator else int(start_text)
            for index in range(int(start_text), end + 1):
                hosts.append(f"{prefix}{str(index).zfill(width)}{suffix}")
    return hosts


def hostlist(text: str | None) -> list[str]:
    """Expand a hostlist, deferring to Slurm for shapes the local parser rejects."""
    if not text or text in _NULLISH:
        return []
    try:
        return expand_hostlist(text)
    except ValueError:
        hosts = [host for host in run_text(["scontrol", "show", "hostnames", text]).split() if host]
        if not hosts:
            # scontrol prints "Invalid hostlist" to stderr and exits 0, so
            # without this the drop would be completely silent.
            log(f"hostlist could not be expanded (truncated or invalid?): {text!r}")
        return hosts


def scontrol_fields(line: str) -> dict[str, str]:
    """Parse one ``scontrol -o`` record into its ``Key=value`` pairs."""
    return dict(re.findall(r"(\w+)=(\S*)", line))


def split_list(value: str | None) -> list[str]:
    if not value or value in _NULLISH:
        return []
    return [item for item in value.split(",") if item]


def collect_lab_users(account: str | None) -> set[str]:
    """Users associated with the lab account, to tell "our" reservations apart."""
    if not account:
        return set()
    stdout = run_text(
        ["sacctmgr", "-n", "-P", "show", "assoc", f"account={account}", "format=User"]
    )
    return {line.split("|", 1)[0].strip() for line in stdout.splitlines() if line.split("|", 1)[0].strip()}


def group_members(name: str) -> set[str]:
    """Members of a Unix group, primary and supplementary. Unknown -> empty."""
    import grp
    import pwd

    try:
        entry = grp.getgrnam(name)
    except KeyError:
        return set()
    members = set(entry.gr_mem)
    try:
        members.update(u.pw_name for u in pwd.getpwall() if u.pw_gid == entry.gr_gid)
    except OSError:
        pass
    return members


def collect_reservations(
    account: str | None, lab_users: set[str]
) -> list[dict[str, Any]]:
    """Every Slurm reservation, with whether the lab can use it.

    An ACTIVE reservation removes its nodes from everyone else's scheduling
    even though sinfo still reports their GPUs as free -- D25 held 8 idle B200s
    on dgx010/dgx013 for three weeks while the dashboard counted them as
    available. Access is by Users, Accounts or Groups; a "-" prefix on a user
    or account is a deny list ("everyone except"). Slurm never creates a
    reservation with no access list at all, so an unreadable one is foreign.
    Even the lab's own reservation only admits a job that asked for it with
    --reservation=NAME unless the reservation is MAGNETIC.

    Member usernames are deliberately not published: the payload is public and
    the old one only ever named lab users.
    """
    reservations: list[dict[str, Any]] = []
    for line in run_text(["scontrol", "-o", "show", "reservation"]).splitlines():
        if not line.strip():
            continue
        fields = scontrol_fields(line)
        name = fields.get("ReservationName")
        if not name:
            continue
        users = split_list(fields.get("Users"))
        accounts = split_list(fields.get("Accounts"))
        groups = split_list(fields.get("Groups"))
        flags = split_list(fields.get("Flags"))
        allowed_users = {u for u in users if not u.startswith("-")}
        allowed_accounts = {a for a in accounts if not a.startswith("-")}
        denied_users = {u[1:] for u in users if u.startswith("-")}
        denied_accounts = {a[1:] for a in accounts if a.startswith("-")}
        deny_only = bool(users or accounts) and not allowed_users and not allowed_accounts
        ours = (
            (account is not None and account in allowed_accounts)
            or bool(allowed_users & lab_users)
            or any(lab_users & group_members(group) for group in groups)
            # A deny-only list admits everyone not named in it.
            or (
                deny_only
                and account not in denied_accounts
                and (not lab_users or bool(lab_users - denied_users))
            )
        )
        nodes = hostlist(fields.get("Nodes"))
        reservations.append(
            {
                "name": name,
                "state": fields.get("State") or None,
                "startTime": fields.get("StartTime") or None,
                "endTime": fields.get("EndTime") or None,
                "nodes": nodes,
                "nodeCount": parse_int(fields.get("NodeCnt")) or len(nodes),
                "userCount": len(allowed_users),
                "accounts": sorted(allowed_accounts),
                "groups": groups,
                "flags": flags,
                "magnetic": any(flag.upper() == "MAGNETIC" for flag in flags),
                "partition": (
                    None if fields.get("PartitionName") in _NULLISH else fields.get("PartitionName")
                ),
                "maintenance": any(flag.upper().startswith("MAINT") for flag in flags),
                "ours": ours,
            }
        )
    return reservations


def collect_planned_nodes(partitions: list[str]) -> dict[str, dict[str, Any]]:
    """Map node -> queued jobs the scheduler has already planned onto it.

    Returns, per node, the list of planned entries (GPUs per node, planned
    start). The PLANNED flag alone is node-wide and cannot say "7 idle, 1
    promised", so the map would otherwise call a whole node held because of one
    queued 1-GPU job. A multi-node plan is split evenly across its nodes.
    CPU-only plans promise no GPU and are skipped, as are rows that are not
    actually waiting for resources (starting, held, dependency, begin time).
    """
    command = ["squeue", "-h", "-t", "PD", "-O", SQUEUE_PLAN_FIELDS]
    if partitions:
        command.extend(["-p", ",".join(partitions)])

    planned: dict[str, dict[str, Any]] = {}
    widths = field_widths(SQUEUE_PLAN_FIELDS)
    for line in run_text(command, timeout=120).splitlines():
        if not line.strip():
            continue
        job_id, user, sched_nodes, start_time, tres, time_limit, partition, reason = (
            slice_fields(line, widths)
        )
        if not job_id or sched_nodes in _NULLISH:
            continue
        if re.search(r"Prolog|Held|Dependency|BeginTime|BadConstraints", reason):
            continue
        gpus = tres_gpu_count(tres)
        if gpus <= 0:
            continue
        if len(sched_nodes) >= widths[2]:
            log(f"SchedNodes for job {job_id} hit column width {widths[2]}; plan may be truncated")
        nodes = hostlist(sched_nodes)
        if not nodes:
            continue
        entry = {
            "jobId": job_id,
            "user": user,
            "gpus": gpus,
            "gpusPerNode": -(-gpus // len(nodes)),  # ceil
            "nodes": len(nodes),
            "startTime": None if start_time in _NULLISH else start_time,
            "timeLimit": time_limit,
            "partition": partition,
        }
        for node in nodes:
            planned.setdefault(node, []).append(entry)
    return planned


def parse_slurm_time(value: str | None) -> datetime | None:
    """Slurm prints cluster-local wall time with no zone; keep it naive."""
    if not value or value in _NULLISH:
        return None
    try:
        return datetime.strptime(value[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None


def collect_jobs(account: str | None) -> list[dict[str, Any]]:
    command = ["squeue", "-h", "-O", SQUEUE_FIELDS]
    if account:
        command.extend(["-A", account])

    jobs: list[dict[str, Any]] = []
    widths = field_widths(SQUEUE_FIELDS)

    for line in run_text(command, required=True).splitlines():
        if not line.strip():
            continue

        (
            job_id,
            user,
            state,
            tres,
            time_used,
            time_limit,
            node_list,
            partition,
            reason,
            name,
            array_task_id,
        ) = slice_fields(line, widths)
        if not job_id:
            continue

        # TRES on a folded array row is per task, so the row's GPU demand is
        # that figure times the number of tasks it stands for.
        gpus_per_task = tres_gpu_count(tres)
        tasks = array_task_count(array_task_id)

        jobs.append(
            {
                "jobId": job_id,
                "user": user,
                "state": state,
                "gpus": gpus_per_task * tasks,
                "gpusPerTask": gpus_per_task,
                "arrayTasks": tasks,
                "timeUsed": time_used,
                "timeLimit": time_limit,
                "nodeList": node_list if node_list not in {"", "n/a"} else None,
                "partition": partition,
                "reason": reason if reason not in {"", "None"} else None,
                "name": name,
                "tres": tres,
            }
        )

    return jobs


def collect_account_usage(
    partitions: list[str],
    pools: list[dict[str, Any]],
    own_account: str | None,
) -> list[dict[str, Any]]:
    """GPU demand per Slurm account on the watched partitions, every group.

    The lab-only job list cannot answer "who holds the GPUs": the cluster-wide
    tile says 230 of 232 are busy without saying whose they are. This reads the
    whole queue and folds it to one row per account, sorted by running GPUs.

    Aggregates only. The payload is public, so a row carries the account name,
    GPU and job counts and the number of distinct users, never a username --
    the rule already applied to queued jobs and reservations. Account names
    themselves are no secret: a reservation's access list publishes them.

    A job counts when any of its partitions is watched, so a queued job that
    lists "slice-large,slice-small" is in and a cpu CPU job is out. Running
    GPUs are also split by quota pool with the same partition mapping the pool
    tiles use, so the table can say "25 on Full B200" rather than just "25".
    """
    command = ["squeue", "-h", "-a", "-O", SQUEUE_ACCOUNT_FIELDS]
    widths = field_widths(SQUEUE_ACCOUNT_FIELDS)
    watched = set(partitions)

    def pool_key(job_partitions: set[str]) -> str | None:
        for pool in pools:
            members = set(pool["partitions"])
            # An empty list means the pool covers everything this agent watches.
            if not members or members & job_partitions:
                return pool["key"]
        return None

    rows: dict[str, dict[str, Any]] = {}
    users: dict[str, set[str]] = defaultdict(set)
    for line in run_text(command).splitlines():
        if not line.strip():
            continue
        account, user, state, tres, partition, array_task_id = slice_fields(
            line, widths
        )
        state = state.upper()
        if not account or state not in {"RUNNING", "PENDING"}:
            continue
        job_partitions = {p for p in partition.split(",") if p}
        if watched and not watched & job_partitions:
            continue
        # Per-task TRES on a folded array row, times the tasks it stands for.
        gpus = tres_gpu_count(tres) * array_task_count(array_task_id)
        if gpus <= 0:
            continue

        row = rows.setdefault(
            account,
            {
                "account": account,
                "ours": account == own_account,
                "gpusUsed": 0,
                "gpusPending": 0,
                "runningJobs": 0,
                "pendingJobs": 0,
                "users": 0,
                "byPool": {},
            },
        )
        users[account].add(user)
        if state == "RUNNING":
            row["gpusUsed"] += gpus
            row["runningJobs"] += 1
            key = pool_key(job_partitions)
            if key is not None:
                row["byPool"][key] = row["byPool"].get(key, 0) + gpus
        else:
            row["gpusPending"] += gpus
            row["pendingJobs"] += 1

    for account, row in rows.items():
        row["users"] = len(users[account])

    return sorted(
        rows.values(),
        key=lambda row: (-row["gpusUsed"], -row["gpusPending"], row["account"]),
    )


def collect_qos_gpu_cap(qos: str) -> dict[str, Any]:
    """Read one QOS's per-account GPU ceiling.

    On ATLAS the binding limit is this cap, not the physical node count, so it
    is what the dashboard should show as capacity.
    """
    stdout = run_text(
        [
            "sacctmgr",
            "-n",
            "-P",
            "show",
            "qos",
            qos,
            "format=Name,MaxTRESPerAccount,GrpTRES",
        ]
    )

    for line in stdout.splitlines():
        parts = line.split("|")
        if len(parts) < 3:
            continue
        name, max_tres_per_account, grp_tres = parts[:3]
        for label, value in (
            ("MaxTRESPerAccount", max_tres_per_account),
        ):
            match = re.search(r"gres/gpu=(\d+)", value or "")
            if match:
                return {
                    "totalGpus": int(match.group(1)),
                    "source": f"sacctmgr qos {name} {label}",
                    "raw": value,
                }

    return {"totalGpus": None, "source": f"sacctmgr qos {qos} (no gpu limit found)"}


def collect_pool_caps(
    cluster: str, overrides: dict[str, int], allocation_gpus: int | None
) -> list[dict[str, Any]]:
    pools = []
    for spec in pools_for_cluster(cluster):
        if spec["key"] in overrides:
            cap = {"totalGpus": overrides[spec["key"]], "source": "manual override"}
        elif spec["qos"]:
            cap = collect_qos_gpu_cap(spec["qos"])
            if cap["totalGpus"] is None:
                cap = {"totalGpus": spec["capacity"], "source": "configured fallback"}
        elif allocation_gpus is not None:
            cap = {"totalGpus": allocation_gpus, "source": "--allocation-gpus"}
        else:
            cap = {"totalGpus": spec["capacity"], "source": "configured capacity"}
        pools.append({**spec, **cap})
    return pools


def classify_nodes(
    nodes: list[dict[str, Any]],
    reservations: list[dict[str, Any]],
    planned_for: dict[str, list[dict[str, Any]]],
    now: datetime,
    horizon_seconds: int = PLAN_HORIZON_SECONDS,
) -> None:
    """Split each node's idle GPUs into what a lab job could actually get.

    "Free" in sinfo is not "schedulable": an idle GPU inside a reservation a
    plain sbatch cannot enter, or one the scheduler has already promised to a
    queued job about to start, will not run a new lab job now. Plans further
    out do not hold the GPU -- backfill happily runs a short job in front of
    them -- so they only bound how long a job could run there (``openUntil``).
    Offline nodes have no free GPUs.
    """
    active_by_node: dict[str, dict[str, Any]] = {}
    for reservation in reservations:
        if reservation["state"] != "ACTIVE":
            continue
        for node_name in reservation["nodes"]:
            # Keep the most restrictive: a foreign reservation beats ours.
            current = active_by_node.get(node_name)
            if current is None or (current["ours"] and not reservation["ours"]):
                active_by_node[node_name] = reservation

    horizon = now + timedelta(seconds=horizon_seconds)

    for node in nodes:
        free = 0 if node["offline"] else max(0, node["gpuTotal"] - node["gpuUsed"])
        reservation = active_by_node.get(node["node"])
        # Slurm also flags a reserved node in its state. If the reservation
        # record itself could not be read (scontrol hiccup), trust the flag
        # and assume the worst: reserved for someone else.
        flagged_reserved = "reserved" in node["flags"]
        if reservation:
            node["reservation"] = {
                "name": reservation["name"],
                "endTime": reservation["endTime"],
                "ours": reservation["ours"],
                "magnetic": reservation["magnetic"],
                "maintenance": reservation["maintenance"],
            }
        elif flagged_reserved:
            node["reservation"] = {
                "name": None, "endTime": None, "ours": False,
                "magnetic": False, "maintenance": False,
            }
        else:
            node["reservation"] = None
        # Only a MAGNETIC reservation attracts jobs that did not ask for it;
        # any other one, ours included, needs sbatch --reservation=NAME.
        held = node["reservation"] is not None and not (
            node["reservation"]["ours"] and node["reservation"]["magnetic"]
        )

        reserved = free if held else 0
        remaining = free - reserved

        entries = sorted(
            planned_for.get(node["node"], []),
            key=lambda e: e["startTime"] or "~",
        )
        soon: list[dict[str, Any]] = []
        later: list[dict[str, Any]] = []
        for entry in entries:
            start = parse_slurm_time(entry["startTime"])
            (soon if start is not None and start <= horizon else later).append(entry)

        planned = min(remaining, sum(e["gpusPerNode"] for e in soon))
        schedulable = remaining - planned
        # The plan that shapes this node's number: the one about to take the
        # GPUs, else the next one that bounds how long they stay open.
        binding = soon[0] if soon else (later[0] if later else None)
        open_until = (
            later[0]["startTime"] if schedulable > 0 and later and later[0]["startTime"] else None
        )

        node["plannedFor"] = binding
        node["plannedJobs"] = len(entries)
        node["openUntil"] = open_until
        node["gpuFree"] = free
        node["gpuReserved"] = reserved
        node["gpuPlanned"] = planned
        node["gpuSchedulable"] = schedulable


def build_snapshot(
    args: argparse.Namespace, pools: list[dict[str, Any]], lab_users: set[str]
) -> dict[str, Any]:
    partitions = [p for p in args.gpu_partitions.split(",") if p]
    nodes = collect_nodes(partitions)
    if not nodes:
        raise RuntimeError("No GPU nodes found in configured partitions; snapshot was not published")
    reservations = collect_reservations(args.account, lab_users)
    planned_for = collect_planned_nodes(partitions)
    classify_nodes(nodes, reservations, planned_for, datetime.now())
    watched = {node["node"] for node in nodes}
    for node in nodes:
        # The payload is public and used to name lab users only. Keep it so:
        # a queued job from another group is shown without its owner.
        plan = node["plannedFor"]
        if plan and plan["user"] not in lab_users:
            node["plannedFor"] = {**plan, "user": None}
        # Internal working data the UI never reads.
        node.pop("flags", None)

    # GPU jobs only. CPU-only work does not belong on a GPU dashboard, and the
    # agent's own cpu job would otherwise report itself in every snapshot.
    # Filtering here rather than in the UI keeps the counts, the per-user
    # totals and the visible list consistent with each other.
    jobs = [job for job in collect_jobs(args.account)
            if job["gpus"] > 0 and set(job["partition"].split(",")) & set(partitions)]
    if not args.include_job_names:
        for job in jobs:
            job["name"] = ""

    # Every group's GPU demand on the watched partitions: whose cards the
    # cluster-wide tile is counting as busy.
    by_account = collect_account_usage(partitions, pools, args.account) if args.include_other_accounts else []

    running = [job for job in jobs if job["state"].upper() == "RUNNING"]
    pending = [job for job in jobs if job["state"].upper() == "PENDING"]

    by_user: dict[str, dict[str, int]] = defaultdict(
        lambda: {"runningJobs": 0, "gpusUsed": 0, "pendingJobs": 0, "gpusPending": 0}
    )
    for job in running:
        by_user[job["user"]]["runningJobs"] += 1
        by_user[job["user"]]["gpusUsed"] += job["gpus"]
    for job in pending:
        by_user[job["user"]]["pendingJobs"] += 1
        by_user[job["user"]]["gpusPending"] += job["gpus"]

    # Each pool is scored against its own cap. A job counts towards the pool
    # whose partition list contains it, so MIG usage never lands against the
    # gpu quota -- folding them together used to produce "34/32 used".
    pool_stats = []
    for pool in pools:
        members = set(pool["partitions"])
        # An empty list means the pool covers everything this agent watches.
        def in_pool(job: dict[str, Any]) -> bool:
            return not members or bool(members & set(job["partition"].split(",")))

        pool_running = [job for job in running if in_pool(job)]
        pool_pending = [job for job in pending if in_pool(job)]
        blocked = [
            job for job in pool_pending if job["reason"] == "MaxGRESPerAccount"
        ]
        used = sum(job["gpus"] for job in pool_running)
        total = pool.get("totalGpus")
        pool_nodes = [
            node for node in nodes if not members or members & set(node["partitions"])
        ]
        schedulable = sum(node["gpuSchedulable"] for node in pool_nodes)
        headroom = max(0, total - used) if total is not None else None

        pool_stats.append(
            {
                "key": pool["key"],
                "label": pool["label"],
                "qos": pool["qos"],
                "partitions": pool["partitions"],
                "totalGpus": total,
                "gpusUsed": used,
                "gpusPending": sum(job["gpus"] for job in pool_pending),
                "runningJobs": len(pool_running),
                "pendingJobs": len(pool_pending),
                "atCap": bool(total) and used >= total,
                "jobsBlockedByAccountCap": len(blocked),
                "gpusBlockedByAccountCap": sum(job["gpus"] for job in blocked),
                "capacitySource": pool.get("source"),
                # Physical slices behind the pool, which is a different number
                # from the quota: MIG has 48 slices but the lab may use 8.
                "hardwareGpus": sum(
                    node["gpuTotal"] for node in pool_nodes if not node["offline"]
                ),
                # Idle GPUs in this pool that are not reserved for someone else
                # and not held by backfill -- what a new job could land on.
                "gpusSchedulable": schedulable,
                # ...capped by the lab's remaining quota. This is the number a
                # user actually wants: "how many can I start right now".
                "gpusStartableNow": (
                    min(schedulable, headroom) if headroom is not None else schedulable
                ),
            }
        )

    primary = pool_stats[0] if pool_stats else {}

    summary = {
        # Kept flat for the pool the lab mostly lives in, so older readers and
        # the reservation capacity lookup keep working unchanged.
        "totalGpus": primary.get("totalGpus"),
        "gpusUsed": primary.get("gpusUsed", 0),
        "gpusPending": primary.get("gpusPending", 0),
        "runningJobs": len(running),
        "pendingJobs": len(pending),
        "atAccountCap": primary.get("atCap", False),
        "jobsBlockedByAccountCap": sum(
            pool["jobsBlockedByAccountCap"] for pool in pool_stats
        ),
        "gpusBlockedByAccountCap": sum(
            pool["gpusBlockedByAccountCap"] for pool in pool_stats
        ),
        "pools": pool_stats,
        # Whole-cluster context, so the lab can see whether the machine itself is
        # saturated or just the lab's own share. Offline nodes are excluded from
        # both sides: counting a drained node's 8 GPUs as capacity understates
        # how full the cluster actually is.
        "clusterGpuTotal": sum(n["gpuTotal"] for n in nodes if not n["offline"]),
        "clusterGpuUsed": sum(n["gpuUsed"] for n in nodes if not n["offline"]),
        "clusterGpuOffline": sum(n["gpuTotal"] for n in nodes if n["offline"]),
        "gpuNodes": sum(1 for n in nodes if not n["offline"]),
        "offlineNodes": sum(1 for n in nodes if n["offline"]),
        # Idle is not schedulable. This is the split that explains "the board
        # shows free GPUs but my job sits in the queue".
        "clusterGpuFree": sum(n["gpuFree"] for n in nodes),
        "clusterGpuReserved": sum(n["gpuReserved"] for n in nodes),
        "clusterGpuPlanned": sum(n["gpuPlanned"] for n in nodes),
        "clusterGpuSchedulable": sum(n["gpuSchedulable"] for n in nodes),
        "rebootPendingNodes": sum(1 for n in nodes if n["rebootPending"]),
        "plannedNodes": sum(1 for n in nodes if n["planned"]),
        # Reservations touching the watched nodes, active or upcoming. An
        # upcoming MAINT window matters too: jobs that would run into it do
        # not start, which looks exactly like "free GPUs, no scheduling".
        "reservations": [
            {
                **{k: v for k, v in reservation.items() if k != "nodes"},
                "nodes": sorted(watched & set(reservation["nodes"])),
                "idleGpus": sum(
                    node["gpuFree"]
                    for node in nodes
                    if node["node"] in reservation["nodes"]
                ),
            }
            for reservation in reservations
            if watched & set(reservation["nodes"])
        ],
    }

    return {
        "schemaVersion": SCHEMA_VERSION,
        "cluster": args.cluster,
        "collectedAt": datetime.now(timezone.utc).isoformat(),
        "agent": {
            "host": os.uname().nodename,
            "jobId": os.environ.get("SLURM_JOB_ID"),
            "intervalSeconds": args.interval,
            "account": args.account,
            "partitions": partitions,
        },
        "summary": summary,
        "nodes": nodes,
        "jobs": jobs,
        "byUser": dict(by_user),
        # Sorted by running GPUs, the lab's own row flagged `ours`.
        "byAccount": by_account,
    }


# --------------------------------------------------------------------------
# Supabase push
# --------------------------------------------------------------------------


class SupabaseWriter:
    def __init__(self, url: str, service_key: str, timeout: int = 30) -> None:
        self.base = url.rstrip("/")
        self.key = service_key
        self.timeout = timeout

    def _request(
        self,
        method: str,
        path: str,
        body: Any = None,
        prefer: str | None = None,
    ) -> tuple[int, str]:
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            f"{self.base}/rest/v1/{path}",
            data=data,
            method=method,
        )
        request.add_header("apikey", self.key)
        if not self.key.startswith("sb_secret_"):
            request.add_header("Authorization", f"Bearer {self.key}")
        request.add_header("Content-Type", "application/json")
        if prefer:
            request.add_header("Prefer", prefer)

        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return response.status, response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode("utf-8", "replace")
        except (urllib.error.URLError, OSError, TimeoutError) as error:
            return 0, str(error)

    def upsert_live(self, snapshot: dict[str, Any]) -> tuple[int, str]:
        summary = snapshot["summary"]
        row = {
            "cluster": snapshot["cluster"],
            "collected_at": snapshot["collectedAt"],
            "agent_host": snapshot["agent"]["host"],
            "agent_job_id": snapshot["agent"]["jobId"],
            "total_gpus": summary["totalGpus"],
            "gpus_used": summary["gpusUsed"],
            "gpus_pending": summary["gpusPending"],
            "running_jobs": summary["runningJobs"],
            "pending_jobs": summary["pendingJobs"],
            "payload": snapshot,
        }
        return self._request(
            "POST",
            "cluster_live?on_conflict=cluster",
            [row],
            prefer="resolution=merge-duplicates,return=minimal",
        )

    def insert_history(self, snapshot: dict[str, Any]) -> tuple[int, str]:
        summary = snapshot["summary"]
        row = {
            "cluster": snapshot["cluster"],
            "collected_at": snapshot["collectedAt"],
            "total_gpus": summary["totalGpus"],
            "gpus_used": summary["gpusUsed"],
            "gpus_pending": summary["gpusPending"],
            "running_jobs": summary["runningJobs"],
            "pending_jobs": summary["pendingJobs"],
        }
        return self._request(
            "POST",
            "cluster_live_history?on_conflict=cluster,collected_at",
            [row],
            prefer="resolution=ignore-duplicates,return=minimal",
        )

    def trim_history(self, cluster: str, retention_hours: int) -> tuple[int, str]:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=retention_hours)
        # The "+00:00" offset must be percent-encoded: a bare "+" in a query
        # string decodes to a space, which Postgres then rejects as an invalid
        # timestamp -- and the delete silently never runs, so history grows
        # without bound.
        params = urllib.parse.urlencode(
            {"cluster": f"eq.{cluster}", "collected_at": f"lt.{cutoff.isoformat()}"}
        )
        return self._request(
            "DELETE",
            f"cluster_live_history?{params}",
            prefer="return=minimal",
        )


# --------------------------------------------------------------------------
# Main loop
# --------------------------------------------------------------------------


def write_local(path: Path, snapshot: dict[str, Any]) -> None:
    """Write the snapshot atomically so a reader never sees a half file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp.replace(path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cluster", required=True, help="Cluster ID from config/clusters.json.")
    parser.add_argument("--config", default=str(Path(__file__).resolve().parents[1] / "config" / "clusters.json"))
    parser.add_argument("--check-config", action="store_true", help="Validate configuration without contacting Slurm or Supabase.")
    parser.add_argument("--include-job-names", action="store_true", help="Publish lab job names (hidden by default).")
    parser.add_argument("--include-other-accounts", action="store_true", help="Publish other Slurm account aggregates (off by default).")
    parser.add_argument("--account", default=None, help="Override the configured Slurm account.")
    parser.add_argument(
        "--gpu-partitions",
        default=None,
        help="Comma separated partitions scanned for GPU nodes.",
    )
    parser.add_argument(
        "--allocation-gpus",
        type=int,
        help="Explicit capacity override for pools without a QOS. "
        "Ignored where pools derive their cap from a QOS.",
    )
    parser.add_argument(
        "--pool-gpus",
        default="",
        help="Override a pool's cap, e.g. 'slices=8,gpu=16'. Otherwise each pool's "
        "QOS is queried with sacctmgr.",
    )
    parser.add_argument("--interval", type=int, default=60, help="Seconds between polls.")
    parser.add_argument(
        "--history-interval",
        type=int,
        default=300,
        help="Seconds between history samples. 0 disables history.",
    )
    parser.add_argument("--history-retention-hours", type=int, default=48)
    parser.add_argument(
        "--allocation-refresh",
        type=int,
        default=3600,
        help="Seconds between account-limit refreshes.",
    )
    parser.add_argument(
        "--reload-file",
        default="",
        help="Exit with code 90 when this file appears, so a supervisor can "
        "restart the process in place and pick up new code.",
    )
    parser.add_argument("--once", action="store_true", help="Poll once and exit.")
    parser.add_argument("--no-push", action="store_true", help="Skip Supabase writes.")
    parser.add_argument(
        "--output",
        default="live-snapshot.json",
        help="Local snapshot path. Empty string disables the local copy.",
    )
    parser.add_argument(
        "--max-runtime",
        type=int,
        default=0,
        help="Exit cleanly after N seconds. 0 means run until signalled.",
    )
    args = parser.parse_args()
    try:
        config = load_cluster_config(args.config, args.cluster)
    except (ValueError, OSError, KeyError, TypeError) as error:
        parser.error(str(error))
    POOLS_BY_CLUSTER[args.cluster] = config["pools"]
    args.account = args.account or config["account"]
    args.gpu_partitions = args.gpu_partitions or ",".join(
        dict.fromkeys(p for pool in config["pools"] for p in pool["partitions"])
    )
    if args.interval < 15 or args.history_interval < 0 or args.history_retention_hours < 1 or args.allocation_refresh < 15:
        parser.error("interval/allocation-refresh must be >=15s; history-interval >=0; retention >=1h")
    if args.allocation_gpus is not None and args.allocation_gpus < 1:
        parser.error("--allocation-gpus must be positive")
    args.pool_overrides = {}
    pool_keys = {pool["key"] for pool in config["pools"]}
    for item in filter(None, args.pool_gpus.split(",")):
        key, separator, value = item.partition("=")
        if not separator or key.strip() not in pool_keys or not value.isdigit() or int(value) < 1:
            parser.error("--pool-gpus requires configured pool keys with positive integers, e.g. gpu=16")
        args.pool_overrides[key.strip()] = int(value)
    return args


def main() -> int:
    args = parse_args()
    if args.check_config:
        print(f"Configuration OK: {args.cluster}, {len(pools_for_cluster(args.cluster))} pool(s)")
        return 0
    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    writer: SupabaseWriter | None = None
    if not args.no_push:
        url = os.environ.get("SUPABASE_URL", "").strip()
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
        if not url or not key:
            log("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. Use --no-push for a local-only check.")
            return 2
        else:
            writer = SupabaseWriter(url, key)

    output_path = Path(args.output).expanduser() if args.output else None

    overrides: dict[str, int] = args.pool_overrides

    pools = collect_pool_caps(args.cluster, overrides, args.allocation_gpus)
    lab_users = collect_lab_users(args.account)
    log(f"lab users for reservation matching: {len(lab_users)}")
    for pool in pools:
        log(
            f"pool {pool['key']}: {pool.get('totalGpus')} GPUs "
            f"({pool.get('source')}) over {'+'.join(pool['partitions'])}"
        )
    allocation_checked = time.monotonic()
    last_history = 0.0
    started = time.monotonic()
    cycle = 0
    consecutive_push_failures = 0
    last_cycle_ok = False

    while True:
        cycle += 1
        cycle_started = time.monotonic()

        if cycle_started - allocation_checked >= args.allocation_refresh:
            refreshed = collect_pool_caps(
                args.cluster, overrides, args.allocation_gpus
            )
            if any(pool.get("totalGpus") is not None for pool in refreshed):
                if refreshed != pools:
                    log(f"pool caps changed: {pools} -> {refreshed}")
                pools = refreshed
            refreshed_users = collect_lab_users(args.account)
            if refreshed_users:
                lab_users = refreshed_users
            allocation_checked = cycle_started

        if args.account and not lab_users:
            # A slurmdbd hiccup at start-up must not mark the lab's own
            # reservation foreign for the whole hour until the next refresh.
            lab_users = collect_lab_users(args.account)
            if lab_users:
                log(f"lab users for reservation matching: {len(lab_users)}")

        try:
            snapshot = build_snapshot(args, pools, lab_users)
        except Exception as error:  # keep the loop alive through anything transient
            log(f"collection failed: {error!r}")
            snapshot = None

        last_cycle_ok = snapshot is not None
        if snapshot is not None:
            summary = snapshot["summary"]
            pool_text = " | ".join(
                f"{pool['label']} {pool['gpusUsed']}/{pool['totalGpus']}"
                f"{' AT CAP' if pool['atCap'] else ''}"
                for pool in summary["pools"]
            )
            top_accounts = ", ".join(
                f"{row['account']} {row['gpusUsed']}"
                for row in snapshot.get("byAccount", [])[:3]
            )
            top_text = f" | top {top_accounts}" if top_accounts else ""
            log(
                f"cycle {cycle}: {pool_text} | "
                f"{summary['runningJobs']} running, {summary['pendingJobs']} pending "
                f"({summary['jobsBlockedByAccountCap']} blocked by cap) | cluster "
                f"{summary['clusterGpuUsed']}/{summary['clusterGpuTotal']}, "
                f"{summary['clusterGpuFree']} idle -> {summary['clusterGpuSchedulable']} "
                f"schedulable ({summary['clusterGpuReserved']} reserved, "
                f"{summary['clusterGpuPlanned']} backfill-held)"
                f"{top_text}"
            )

            if output_path is not None:
                try:
                    write_local(output_path, snapshot)
                except OSError as error:
                    log(f"local write failed: {error}")

            if writer is not None:
                status, body = writer.upsert_live(snapshot)
                if 200 <= status < 300:
                    consecutive_push_failures = 0
                else:
                    last_cycle_ok = False
                    consecutive_push_failures += 1
                    log(f"live upsert failed ({status}): {body[:300]}")

                if args.history_interval > 0 and (
                    cycle_started - last_history >= args.history_interval
                    or last_history == 0.0
                ):
                    h_status, h_body = writer.insert_history(snapshot)
                    if not 200 <= h_status < 300:
                        log(f"history insert failed ({h_status}): {h_body[:300]}")
                    else:
                        last_history = cycle_started
                        t_status, t_body = writer.trim_history(
                            args.cluster, args.history_retention_hours
                        )
                        if not 200 <= t_status < 300:
                            log(f"history trim failed ({t_status}): {t_body[:200]}")

        if args.once or _shutdown:
            break

        # A code deploy should not cost a Slurm job. Exiting here lets the batch
        # wrapper relaunch the interpreter inside the same allocation, so the
        # job id -- and the queue position behind it -- survives the update.
        if args.reload_file and Path(args.reload_file).exists():
            log("reload requested, exiting for in-place restart")
            return 90

        if args.max_runtime and time.monotonic() - started >= args.max_runtime:
            log(f"reached --max-runtime {args.max_runtime}s, exiting cleanly")
            break

        # Back off when Supabase is unhappy, so a bad key or a dropped network
        # does not hammer the API for seven days.
        delay = args.interval
        if consecutive_push_failures > 3:
            delay = min(args.interval * min(consecutive_push_failures, 10), 900)
            log(f"backing off to {delay}s after {consecutive_push_failures} push failures")

        elapsed = time.monotonic() - cycle_started
        remaining = max(1.0, delay - elapsed)
        # Sleep in slices so SIGTERM is honoured promptly.
        while remaining > 0 and not _shutdown:
            time.sleep(min(2.0, remaining))
            remaining -= 2.0

        if _shutdown:
            break

    log("agent stopped")
    return 0 if not args.once or last_cycle_ok else 1


if __name__ == "__main__":
    sys.exit(main())
