import argparse
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import live_gpu_agent as agent
import manage_agent as manager


class CollectorTests(unittest.TestCase):
    def test_array_tasks_not_concurrency(self):
        self.assertEqual(agent.array_task_count("0-9%3"), 10)
        self.assertEqual(agent.array_task_count("0-8:2,11,15-17%2"), 9)
        self.assertEqual(agent.array_task_count("N/A"), 1)

    def test_gpu_tres_not_double_counted(self):
        self.assertEqual(agent.tres_gpu_count("cpu=4,gres/gpu=2,gres/gpu:a100=2"), 2)
        self.assertEqual(agent.tres_gpu_count("gres/gpu:a100=2,gres/gpu:h100=4"), 6)
        self.assertEqual(agent.tres_gpu_count("cpu=4"), 0)

    def test_gres_with_commas_inside_indices(self):
        self.assertEqual(agent.gres_gpu_count("gpu:a100:3(IDX:0,2-3)"), 3)

    def test_fixed_width_empty_fields(self):
        self.assertEqual(agent.slice_fields("abc   xyz", [3, 3, 3]), ["abc", "", "xyz"])

    def test_hostlist(self):
        self.assertEqual(agent.expand_hostlist("gpu[01-03,07],gpu09"),
                         ["gpu01", "gpu02", "gpu03", "gpu07", "gpu09"])

    def test_required_queries_fail_closed(self):
        with patch.object(agent.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "", "denied")):
            with self.assertRaises(RuntimeError):
                agent.collect_nodes(["gpu"])
            with self.assertRaises(RuntimeError):
                agent.collect_jobs("research-lab")
            self.assertEqual(agent.run_text(["optional-command"]), "")

    def test_members_strip_parsable_separator(self):
        with patch.object(agent, "run_text", return_value="alex|\nblair|\n|\n"):
            self.assertEqual(agent.collect_lab_users("research-lab"), {"alex", "blair"})

    def test_qos_global_limit_is_not_account_limit(self):
        with patch.object(agent, "run_text", return_value="normal||gres/gpu=96|\n"):
            self.assertIsNone(agent.collect_qos_gpu_cap("normal")["totalGpus"])

    def test_reservation_removes_idle_capacity(self):
        node = {"node": "gpu01", "offline": False, "gpuTotal": 8, "gpuUsed": 2, "flags": []}
        reservation = {"nodes": ["gpu01"], "state": "ACTIVE", "ours": False, "name": "maintenance",
                       "endTime": None, "magnetic": False, "maintenance": True}
        agent.classify_nodes([node], [reservation], {}, datetime(2026, 1, 1))
        self.assertEqual(node["gpuFree"], 6)
        self.assertEqual(node["gpuReserved"], 6)
        self.assertEqual(node["gpuSchedulable"], 0)

    def test_configurable_cluster_and_pool_fallback(self):
        config = agent.load_cluster_config(str(manager.REPO / "config/clusters.json"), "ATLAS")
        with patch.dict(agent.POOLS_BY_CLUSTER, {"CUSTOM": config["pools"]}):
            pools = agent.collect_pool_caps("CUSTOM", {}, None)
        self.assertEqual([pool["totalGpus"] for pool in pools], [16, 8])

    def test_overlapping_pool_partitions_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "config.json"
            file.write_text(json.dumps({"clusters": [{"id": "CUSTOM", "account": "lab", "pools": [
                {"key": "a", "capacity": 8, "partitions": ["gpu"]},
                {"key": "b", "capacity": 8, "partitions": ["gpu"]},
            ]}]}))
            with self.assertRaises(ValueError):
                agent.load_cluster_config(str(file), "CUSTOM")

    def test_batch_renewal_preserves_resources_and_no_gpus(self):
        spec = dict(cluster="ATLAS", account="lab", partition="cpu", qos="normal",
                    mem="1G", time="06:00:00", constraint=None, nodelist=None)
        with patch.object(manager.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, "Site banner\n12345;cluster\n")) as run:
            self.assertEqual(manager.submit(spec, "12344"), "12345")
        command = run.call_args.args[0]
        self.assertIn("--dependency=afterany:12344", command)
        self.assertEqual(command[command.index("--partition") + 1], "cpu")
        self.assertEqual(command[command.index("--time") + 1], "06:00:00")
        self.assertFalse(any(arg.startswith(("--gres", "--gpu")) for arg in command))

    def test_batch_submission_failure_not_job_id(self):
        spec = dict(cluster="ATLAS", account="lab", partition="cpu", time="06:00:00")
        with patch.object(manager.subprocess, "run", return_value=subprocess.CompletedProcess([], 1, "error\n12345\n")):
            with self.assertRaises(RuntimeError):
                manager.submit(spec)

    def test_slurm_walltime(self):
        self.assertEqual(manager.duration_seconds("1-02:03:04"), 93784)
        self.assertEqual(manager.duration_seconds("06:00:00"), 21600)
        self.assertEqual(manager.duration_seconds("05:30"), 330)


if __name__ == "__main__":
    unittest.main()
