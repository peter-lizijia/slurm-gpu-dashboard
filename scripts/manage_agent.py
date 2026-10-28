#!/usr/bin/env python3
"""Start, inspect or stop a self-renewing CPU-only Slurm telemetry job."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys

from live_gpu_agent import load_cluster_config

REPO = Path(__file__).resolve().parents[1]


def job_name(cluster: str) -> str:
    suffix = hashlib.sha256(str(REPO).encode()).hexdigest()[:6]
    return f"sgd-{cluster}-{suffix}"


def duration_seconds(value: str) -> int:
    days, _, clock = value.partition("-")
    if not clock:
        clock, days = days, "0"
    parts = [int(part) for part in clock.split(":")]
    if len(parts) == 3:
        seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
    elif len(parts) == 2:
        seconds = parts[0] * 60 + parts[1]
    else:
        seconds = parts[0] * 60
    return int(days) * 86400 + seconds


def queue(cluster: str) -> list[tuple[str, str]]:
    result = subprocess.run(["squeue", "-h", "-u", getpass.getuser(), "-n", job_name(cluster),
                             "-o", "%i|%T"], text=True, capture_output=True, check=True)
    return [tuple(line.strip().split("|", 1)) for line in result.stdout.splitlines() if "|" in line]


@contextlib.contextmanager
def locked(state: Path):
    with (state / "lock").open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def submit(spec: dict, dependency: str | None = None) -> str:
    cluster = spec["cluster"]
    command = ["sbatch", "--parsable", "--requeue", "--job-name", job_name(cluster),
               "--ntasks=1", "--cpus-per-task=1", "--time", spec["time"],
               "--partition", spec["partition"], "--account", spec["account"],
               "--chdir", str(REPO), "--open-mode=append",
               "--output", str(REPO / "logs" / f"{cluster}-%j.out")]
    for option in ("qos", "mem", "constraint", "nodelist"):
        if spec.get(option):
            command.extend([f"--{option}", spec[option]])
    if dependency:
        command.extend([f"--dependency=afterany:{dependency}", "--kill-on-invalid-dep=yes"])
    command.extend([str(REPO / "scripts/run_agent.sbatch"), str(REPO), cluster])
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    ids = re.findall(r"^([0-9]+)(?:;[^\s]+)?$", result.stdout, re.MULTILINE)
    if result.returncode or not ids:
        raise RuntimeError(f"sbatch failed: {result.stdout.strip()}")
    return ids[-1]


def load_secrets() -> dict[str, str]:
    path = REPO / ".env.server"
    if path.stat().st_mode & 0o077:
        raise ValueError("Run chmod 600 .env.server before starting the agent")
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if separator:
            values[key.strip()] = value.strip().strip("\"'")
    for key in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        if not values.get(key) or "your-project" in values[key] or "replace-with" in values[key]:
            raise ValueError(f"Configure {key} in .env.server")
    return values


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["start", "status", "stop", "run"])
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--partition", help="CPU partition in which the monitoring job runs")
    parser.add_argument("--account", help="Slurm billing account; defaults to the cluster config")
    parser.add_argument("--time", default="06:00:00")
    parser.add_argument("--qos")
    parser.add_argument("--mem", help="Optional site-appropriate memory request, e.g. 1G")
    parser.add_argument("--constraint")
    parser.add_argument("--nodelist")
    parser.add_argument("--include-job-names", action="store_true")
    parser.add_argument("--include-other-accounts", action="store_true")
    args = parser.parse_args()
    config = load_cluster_config(str(REPO / "config/clusters.json"), args.cluster)
    state = REPO / "runtime" / args.cluster
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    (REPO / "logs").mkdir(exist_ok=True)
    stop = state / "STOP"

    if args.action == "status":
        jobs = queue(args.cluster)
        print("\n".join(f"{job} {status}" for job, status in jobs) or "No active agent jobs")
        return 0

    if args.action == "stop":
        with locked(state):
            stop.touch()
            jobs = queue(args.cluster)
            if jobs:
                subprocess.run(["scancel", *[job for job, _ in jobs]], check=True)
        print("Stopped this checkout's agent chain")
        return 0

    secrets = load_secrets()
    if args.action == "start":
        if not args.partition:
            parser.error("start requires --partition (an allowed CPU or monitoring partition)")
        if duration_seconds(args.time) < 300:
            parser.error("Use a wall time of at least five minutes")
        with locked(state):
            if queue(args.cluster):
                raise ValueError("An agent chain is already active; use status or stop first")
            spec = vars(args).copy()
            spec["account"] = args.account or config["account"]
            (state / "job.json").write_text(json.dumps(spec, indent=2) + "\n")
            stop.unlink(missing_ok=True)
            job = submit(spec)
        print(f"Submitted {job}; log: {REPO / 'logs' / (args.cluster + '-' + job + '.out')}")
        return 0

    # Run on the allocated node. The saved options survive every successor.
    spec = json.loads((state / "job.json").read_text())
    job = os.environ.get("SLURM_JOB_ID")
    if not job:
        raise ValueError("The run action is for Slurm jobs; use start on the login node")
    with locked(state):
        if stop.exists():
            return 0
        if not any(other != job for other, _ in queue(args.cluster)):
            try:
                successor = submit(spec, dependency=job)
                print(f"Successor: {successor} (after {job})", flush=True)
            except RuntimeError as error:
                print(f"WARNING: renewal failed; monitoring will stop at walltime: {error}", flush=True)

    remaining = subprocess.run(["squeue", "-h", "-j", job, "-o", "%L"],
                               capture_output=True, text=True, check=True).stdout.strip()
    runtime = max(1, duration_seconds(remaining) - 60)
    command = [sys.executable, "-u", str(REPO / "scripts/live_gpu_agent.py"),
               "--cluster", args.cluster, "--max-runtime", str(runtime),
               "--output", str(state / "live-snapshot.json")]
    for option in ("include_job_names", "include_other_accounts"):
        if spec.get(option):
            command.append("--" + option.replace("_", "-"))
    child = subprocess.Popen(command, env={**os.environ, **secrets})
    def forward(signum, _frame):
        if child.poll() is None:
            child.send_signal(signum)
    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    return child.wait()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Agent setup failed: {error}", file=sys.stderr)
        sys.exit(1)
