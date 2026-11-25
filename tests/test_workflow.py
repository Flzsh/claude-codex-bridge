import concurrent.futures
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[1]
SLUG = "trio-claude-gemini-codex"
SCRIPTS = REPO / "plugins" / SLUG / "skills" / SLUG / "scripts"
sys.path.insert(0, str(SCRIPTS))
import flow


class FlowTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.task = Path(temp.name)

    def command(self, now_ms, action, *args, expected=0):
        output = io.StringIO()
        with patch.object(flow.time, "time_ns", return_value=now_ms * 1_000_000):
            with redirect_stdout(output), redirect_stderr(io.StringIO()):
                code = flow.main([action, str(self.task), *args])
        self.assertEqual(code, expected)
        return json.loads(output.getvalue()) if output.getvalue() else None

    def test_plan_timeout_has_its_own_status_and_survives_reopening(self):
        first = self.command(1_000, "open", "plan", "plan-1", "--timed")
        reopened = self.command(30_999, "open", "plan", "plan-1", "--timed")
        self.assertEqual(reopened, first)
        self.assertEqual(self.command(30_999, "check", "plan", "plan-1", expected=1)["status"], "waiting")
        expired = self.command(31_000, "check", "plan", "plan-1")
        self.assertEqual((expired["status"], expired["agent"]), ("continued_after_timeout", "workflow"))
        self.assertEqual(self.command(32_000, "status", "plan"), expired)
        self.command(33_000, "resolve", "plan", first["gate_id"], "approve", expected=2)
        self.assertEqual(len((self.task / "events.jsonl").read_text().splitlines()), 2)

    def test_hold_stops_timer_and_a_revision_supersedes_an_old_gate(self):
        initial = self.command(1_000, "open", "plan", "plan-1", "--timed")
        self.command(10_000, "resolve", "plan", initial["gate_id"], "hold")
        self.assertEqual(self.command(60_000, "status", "plan")["status"], "held")
        revised = self.command(61_000, "open", "plan", "plan-2", "--timed")
        self.command(62_000, "resolve", "plan", initial["gate_id"], "approve", expected=2)
        self.assertEqual(self.command(62_000, "status", "plan"), revised)
        self.command(63_000, "resolve", "plan", revised["gate_id"], "decline")
        self.assertEqual(self.command(100_000, "check", "plan", "plan-2", expected=1)["status"], "declined")

    def test_manual_plan_has_no_deadline(self):
        self.command(1_000, "open", "plan", "plan-1")
        status = self.command(100_000, "check", "plan", "plan-1", expected=1)
        self.assertEqual(status["status"], "waiting")
        self.assertIsNone(status["deadline_ms"])

    def test_shipping_actions_require_separate_explicit_approval(self):
        for gate in ("push", "merge", "deploy"):
            with self.subTest(gate=gate):
                with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as exc:
                    flow.main(["open", str(self.task), gate, "revision-1", "--timed"])
                self.assertEqual(exc.exception.code, 2)
                first = self.command(1_000, "open", gate, "revision-1")
                self.assertIsNone(first["deadline_ms"])
                result = subprocess.run(
                    [sys.executable, flow.__file__, "check", str(self.task), gate, "revision-1"],
                    capture_output=True, text=True,
                )
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(json.loads(result.stdout)["status"], "waiting")
                self.command(70_000, "resolve", gate, first["gate_id"], "approve")
                self.command(70_000, "check", gate, "revision-1")
                self.command(70_000, "check", gate, "revision-2", expected=1)

    def test_bridge_fixture_replays_a_worker_failure_and_pending_push(self):
        fixture = REPO / "tests" / "fixtures" / "bridge-run.jsonl"
        (self.task / "events.jsonl").write_bytes(fixture.read_bytes())
        events = [json.loads(line) for line in fixture.read_text().splitlines()]
        self.assertIn(("codex", "failed"), {(event["agent"], event["status"]) for event in events})
        self.assertEqual(self.command(100_000, "status", "plan")["status"], "continued_after_timeout")
        self.assertEqual(self.command(100_000, "status", "push")["status"], "waiting")


class ScriptTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name).resolve()
        self.repo = self.base / "project with spaces"
        self.repo.mkdir()
        self.bin = self.base / "bin"
        self.bin.mkdir()
        self.env = {
            **os.environ,
            "PATH": str(self.bin) + os.pathsep + os.environ["PATH"],
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Trio test",
            "GIT_AUTHOR_EMAIL": "trio@example.test",
            "GIT_COMMITTER_NAME": "Trio test",
            "GIT_COMMITTER_EMAIL": "trio@example.test",
            "MM_WORKTREES": str(self.base / "worktrees"),
            "TRIO_CAPTURE": str(self.base / "capture.json"),
        }
        self.run_command("git", "init", "-q")
        (self.repo / "implementation.txt").write_text("Fixture implementation.\n")
        self.run_command("git", "add", "implementation.txt")
        self.run_command("git", "commit", "-qm", "initial")

    def run_command(self, executable, *args, expected=0):
        result = subprocess.run(
            [str(executable), *(str(arg) for arg in args)],
            cwd=self.repo, env=self.env, capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result.stdout.strip()

    def stub(self, name, source):
        script = self.bin / name
        script.write_text("#!" + sys.executable + "\n" + source)
        script.chmod(0o755)

    def new_task(self):
        return Path(self.run_command(SCRIPTS / "init_task.sh", "Same title"))

    def test_parallel_tasks_get_unique_paths_and_artifacts_stay_local(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
            tasks = list(workers.map(lambda _: self.new_task(), range(4)))
        self.assertEqual(len(set(tasks)), 4)
        for task in tasks:
            artifact = task / "raw-prompt.md"
            artifact.write_text("Synthetic prompt.\n")
            self.run_command("git", "check-ignore", artifact)
        self.assertTrue((self.repo / ".multimodel/config.yaml").is_file())

    def test_init_keeps_existing_project_config_and_ignore_rules(self):
        config = self.repo / ".multimodel/config.yaml"
        config.parent.mkdir()
        config.write_text("test_command: my-test\n")
        ignore = config.parent / ".gitignore"
        ignore.write_text("worktrees/\ncustom/\n")
        self.new_task()
        self.assertEqual(config.read_text(), "test_command: my-test\n")
        self.assertEqual(ignore.read_text(), "worktrees/\ncustom/\n")
        self.run_command("git", "check-ignore", ".multimodel/tasks/future/run.log")

    def dispatch(self, task, expected=0):
        ticket = task / "ticket.md"
        ticket.write_text("Synthetic ticket.\n")
        self.run_command(SCRIPTS / "dispatch_codex.sh", ticket, task, expected=expected)
        return f"mm/{task.name}-codex"

    def test_failed_codex_preserves_partial_work_without_a_commit_or_receipt(self):
        self.stub("codex", """import pathlib, sys
args = sys.argv
pathlib.Path(args[args.index('--cd') + 1], 'partial.txt').write_text('partial')
pathlib.Path(args[args.index('--output-last-message') + 1]).write_text('partial result')
sys.exit(7)
""")
        task = self.new_task()
        branch = self.dispatch(task, expected=7)
        self.assertEqual(self.run_command("git", "rev-parse", branch), self.run_command("git", "rev-parse", "HEAD"))
        self.assertFalse((task / "05-receipt-codex.md").exists())
        self.assertTrue((task / "05-receipt-codex.partial.md").is_file())
        self.assertTrue((self.base / "worktrees" / self.repo.name / (task.name + "-codex") / "partial.txt").is_file())
        self.dispatch(task, expected=1)

    def test_successful_codex_commits_before_finalizing_its_receipt(self):
        self.stub("codex", """import pathlib, sys
args = sys.argv
pathlib.Path(args[args.index('--cd') + 1], 'complete.txt').write_text('done')
pathlib.Path(args[args.index('--output-last-message') + 1]).write_text('complete result')
""")
        task = self.new_task()
        branch = self.dispatch(task)
        self.assertEqual(self.run_command("git", "show", f"{branch}:complete.txt"), "done")
        self.assertEqual((task / "05-receipt-codex.md").read_text(), "complete result")

    def test_gemini_isolated_and_repo_aware_calls_use_distinct_inputs(self):
        self.stub("agy", """import json, os, pathlib, sys
pathlib.Path(os.environ['TRIO_CAPTURE']).write_text(json.dumps([os.getcwd(), sys.argv[1:]]))
print(json.dumps({'status': 'SUCCESS', 'response': 'Synthetic result'}))
""")
        task = self.new_task()
        prompt = task / "prompt.md"
        prompt.write_text("Contract and pre-existing test setup.\n")
        answer = task / "answer.md"
        capture = Path(self.env["TRIO_CAPTURE"])

        self.run_command(SCRIPTS / "ask_gemini.sh", "--isolated", prompt, answer)
        cwd, args = json.loads(capture.read_text())
        self.assertNotEqual(Path(cwd), self.repo)
        self.assertFalse(Path(cwd).exists())
        sent = args[args.index("-p") + 1]
        self.assertIn(prompt.read_text().strip(), sent)
        self.assertNotIn("implementation.txt", sent)
        self.assertNotIn(str(self.repo), sent)
        deny = json.loads(args[args.index("--settings") + 1])["permissions"]["deny"]
        self.assertTrue({"read_file(*)", "write_file(*)", "command(*)", "mcp(*)"}.issubset(deny))
        self.assertEqual(answer.read_text(), "Synthetic result\n")

        self.run_command(SCRIPTS / "ask_gemini.sh", prompt, answer)
        cwd, args = json.loads(capture.read_text())
        self.assertEqual(Path(cwd), self.repo)
        self.assertIn("implementation.txt", args[args.index("-p") + 1])


if __name__ == "__main__":
    unittest.main()
