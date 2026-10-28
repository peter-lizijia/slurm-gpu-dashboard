# Run a Slurm GPU collector

## Requirements

- A normal Slurm login with permission to inspect the relevant jobs, nodes and account associations.
- Python 3.10+ and `squeue`, `sinfo`, `scontrol`, `sacctmgr`, `sbatch`, `scancel` on the cluster.
- A shared checkout readable from the login and allocated nodes.
- Outbound HTTPS to **your** Supabase project from the allocated node.
- An approved CPU/monitoring partition and Slurm billing account.

No root access, GPU allocation, pip packages, Node.js or npm are needed on the cluster. Local policy may restrict queries or long-lived monitoring; consult your administrator. The collector does not inspect filesystems or scan storage.

## First inspect your environment

```bash
id
sacctmgr -nP show assoc user="$USER" format=Account,User,Partition,QOS
sinfo -N -h -o '%N|%P|%t|%G'
squeue -A YOUR_ACCOUNT -o '%.18i %.16u %.12P %.10T %.20b %.30R'
```

Replace `YOUR_ACCOUNT`. Confirm the actual GPU entitlement and pool layout; visible hardware is not necessarily your group's allowance.

## Clone and validate

Clone your customized repository in an appropriate shared location. Edit `config/clusters.json` as described in [deployment](deployment.md). These examples use fictional cluster ID `ATLAS`:

```bash
git clone https://github.com/YOUR_USER/YOUR_REPO.git
cd YOUR_REPO
python3 scripts/live_gpu_agent.py --cluster ATLAS --check-config
python3 scripts/live_gpu_agent.py --cluster ATLAS --once --no-push \
  --output runtime/ATLAS/live-snapshot.json
```

The second command issues one round of Slurm metadata queries and writes a local JSON snapshot. It does not upload anything. Use the login node only if your site's policy permits these queries. Inspect the JSON locally before publishing. If required `sinfo`/`squeue` queries fail, the cycle fails instead of publishing false zeros. Optional reservation/limit metadata can be unavailable; heed warnings in the log.

## Configure the server-only key

Create your own Supabase project and schema first. Copy its secret key (or legacy `service_role` key) into the following local file:

```bash
cp .env.server.example .env.server
chmod 600 .env.server
```

Edit `.env.server` with a text editor:

```dotenv
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=YOUR_SERVER_SECRET
```

The variable name supports both the current `sb_secret_...` format and legacy service-role JWTs. Never paste the key into issues, commits, frontend variables, or command arguments. The job manager reads this file and passes the values only to the child process. Anyone with this key has privileged database access; use a dedicated project and secure the account/files accordingly.

## Start one persistent agent per cluster

From that cluster's login node:

```bash
python3 scripts/manage_agent.py start --cluster ATLAS \
  --partition YOUR_CPU_PARTITION --time 06:00:00
python3 scripts/manage_agent.py status --cluster ATLAS
```

The billing account defaults to the config's monitored account. Add `--account`, `--qos`, `--mem 1G`, `--constraint`, or `--nodelist` only as required by your site. Overriding the billing account does **not** change which account is monitored. The submission requests one task and one CPU, with no GPU request. Site memory defaults apply unless you supply `--mem`.

At startup, each running job schedules one successor using Slurm's [`afterany` dependency](https://slurm.schedmd.com/sbatch.html). The collector exits shortly before walltime; its successor can then start. Queuing, site maintenance or failed successor submission may leave monitoring gaps. Requeue is requested, not guaranteed. Check status and logs after the first renewal.

```bash
tail -f logs/ATLAS-JOB_ID.out
python3 scripts/manage_agent.py stop --cluster ATLAS
```

Replace `JOB_ID` with the submitted ID. `stop` writes a stop marker and cancels the current and pending successor jobs belonging to this user, cluster and checkout. Keep the checkout path stable. Simply closing a terminal does not stop the chain.

Repeat on your other cluster with its configured ID (for example `ORION`). Point both collectors at your own shared Supabase project. Leave each cluster ID with exactly one active writer.

## Data and cadence

- Every 60 seconds: current snapshot in `cluster_live`, keyed by cluster ID.
- Every 5 minutes: summary sample in `cluster_live_history`.
- History retention: 48 hours, pruned by the writer for its own cluster.
- Local snapshot: `runtime/CLUSTER/live-snapshot.json`.
- Logs: `logs/CLUSTER-JOB_ID.out`; logs are not automatically rotated, so manage retention locally.

Job names are blank by default. Other accounts' usage aggregates are omitted by default. Opt in at `start` with `--include-job-names` or `--include-other-accounts` only after privacy review. This does **not** anonymize node names, own-account usernames, job IDs, pending reasons, or scheduler reservation metadata. All uploaded telemetry is publicly readable under the supplied schema.

The standalone `live_gpu_agent.py --help` exposes poll/history intervals, pool cap overrides and one-shot operation. The job manager intentionally uses conservative defaults. No GPU kernels or `nvidia-smi` calls are made. Displayed availability is a scheduling estimate; CPU, memory, priority, reservations, QOS and future backfill constraints can still block work.

## Updates and troubleshooting

Stop the chain, `git pull --ff-only`, review config/migrations, then start it again. Runtime files, logs and `.env.server` are ignored by Git. The agent never automatically pulls, commits or pushes repositories. Changing frontend configuration also requires a rebuild.

| Symptom | Check |
| --- | --- |
| `Permission denied` reading Slurm info | Account visibility and site policy; do not elevate privileges to bypass restrictions. |
| Pending monitoring job | Valid CPU partition, billing account, QOS, walltime and available resources. |
| `No GPU nodes found` | GPU partition names, GRES configuration and node visibility. |
| Database 401/403 | Project URL, server-only key, explicit grants, project health. |
| Missing table or column | Apply this repository's schema to a new project before starting. |
| Stale dashboard | Logs, outbound HTTPS, job chain, correct cluster ID and frontend environment. |
| Unexpected capacity | Configured pool budget and QOS `MaxTRESPerAccount`, not cluster-wide hardware. |
| Renewal stops | Successor submission error/site limits; restart after resolving it. |

The repository tests parsers and job commands with synthetic fixtures. Validate against your site's Slurm version and policies before relying on the deployment; there is no universal Slurm configuration.
