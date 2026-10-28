#!/bin/bash -l
# Scheduling options are supplied by manage_agent.py; no site-specific directives.
set -euo pipefail
repo="$1"
cluster="$2"
cd "$repo"
exec python3 "$repo/scripts/manage_agent.py" run --cluster "$cluster"
