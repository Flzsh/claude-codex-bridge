"""Offline integration tests using temporary Git repositories and mock CLIs."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parents[1] / "plugins/trio-claude-gemini-codex/skills/trio-claude-gemini-codex/scripts"


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name)
        self.repo = self.home / "project with spaces"
        self.repo.mkdir()
        self.bin = self.home / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}",
                        MM_WORKTREES=str(self.home / "worktrees"))
        self.git("init", "-q")
        self.git("config", "user.name", "Trio Test")
        self.git("config", "user.email", "trio@example.invalid")
        (self.repo / "tracked.txt").write_text("original\n")
        self.git("add", "tracked.txt")
        self.git("commit", "-qm", "initial")
        self.mock("sleep", "#!/bin/sh\nexit 0\n")
        self.mock("gh", "#!/bin/sh\nexit 0\n")
        self.mock("codex", '''#!/usr/bin/env python3
import os, sys
from pathlib import Path
a=sys.argv[1:]
if a[0] != "exec":
    sys.exit(0)
mode=os.environ.get("MOCK_CODEX", "success")
prompt=sys.stdin.read()
out=Path(a[a.index("--output-last-message")+1])
root=Path(a[a.index("--cd")+1])
if "workspace-write" in a:
    (root/"generated.txt").write_text("generated")
    if mode=="fail": sys.exit(9)
    out.write_text("receipt\\n")
else:
    if mode=="no-output": sys.exit(0)
    if mode=="bad-verdict": out.write_text("VERDICT: MAYBE\\n")
    else:
        assert "Review exactly these commits" in prompt
        out.write_text("review\\nVERDICT: APPROVE\\n")
''')
        self.mock("agy", '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
a=sys.argv[1:]
if "--version" in a:
    print("mock")
    sys.exit(0)
prompt=a[a.index("-p")+1]
if "exactly the word PONG" in prompt:
    print(json.dumps({"status":"SUCCESS","response":"PONG"}))
else:
    if "read-only test author" in prompt:
        assert not (Path.cwd()/".git").exists()
        assert "Files in this repository" not in prompt
    print(json.dumps({"status":"SUCCESS","response":"model answer"}))
    if os.environ.get("MOCK_AGY")=="fail": sys.exit(8)
''')
        self.task = Path(self.run_script("init_task.sh", "test").stdout.strip())
        self.prompt = self.task / "prompt.md"
        self.prompt.write_text("test prompt\n")

    def mock(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.repo, env=self.env, text=True).strip()

    def run_script(self, script, *args, ok=True, **env):
        result = subprocess.run([str(SCRIPTS / script), *map(str, args)], cwd=self.repo,
                                env=dict(self.env, **env), capture_output=True, text=True, timeout=20)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def state(self, output):
        return json.loads(Path(str(output) + ".run.json").read_text())["state"]

    def test_config_and_task_resume(self):
        cfg = self.repo / ".multimodel/config.yaml"
        with cfg.open("a") as f:
            f.write('extra: "a # b" # comment\n')
        self.assertEqual(self.run_script("cfg.sh", "extra").stdout.strip(), "a # b")
        second = Path(self.run_script("init_task.sh", "test").stdout.strip())
        self.assertNotEqual(second, self.task)
        resumed = self.run_script("init_task.sh", "--resume", self.task.name).stdout.strip()
        self.assertEqual(Path(resumed), self.task)
        status = json.loads(self.run_script("task_status.py").stdout)
        self.assertEqual(len(status["tasks"]), 2)

    def test_dispatch_success(self):
        self.run_script("dispatch_codex.sh", self.prompt, self.task)
        receipt = self.task / "05-receipt-codex.md"
        self.assertEqual(self.state(receipt), "succeeded")
        branch = f"mm/{self.task.name}-codex"
        self.assertEqual(self.git("show", f"{branch}:generated.txt"), "generated")
        self.assertFalse((self.repo / "generated.txt").exists())
        status = json.loads(self.run_script("task_status.py", self.task.name).stdout)
        build = next(p for p in status["task"]["phases"] if p["id"] == "build")
        self.assertEqual(next(a for a in build["artifacts"] if a["path"] == receipt.name)["run"]["state"], "succeeded")

    def test_failed_dispatch_does_not_commit(self):
        before = self.git("rev-parse", "HEAD")
        result = self.run_script("dispatch_codex.sh", self.prompt, self.task, ok=False, MOCK_CODEX="fail")
        self.assertEqual(result.returncode, 9)
        branch = f"mm/{self.task.name}-codex"
        self.assertEqual(self.git("rev-parse", branch), before)
        receipt = self.task / "05-receipt-codex.md"
        self.assertFalse(receipt.exists())
        self.assertEqual(self.state(receipt), "failed")
        self.assertTrue(list((self.home / "worktrees").glob("*/*/generated.txt")))
        self.run_script("dispatch_codex.sh", self.prompt, self.task, ok=False)

    def test_review_rejects_stale_and_invalid(self):
        out = self.task / "08-review-codex-r1.md"
        self.run_script("codex_review.sh", "HEAD", self.prompt, out)
        self.assertEqual(self.state(out), "succeeded")
        self.run_script("codex_review.sh", "HEAD", self.prompt, out, ok=False, MOCK_CODEX="no-output")
        self.assertFalse(out.exists())
        self.assertEqual(self.state(out), "failed")
        self.run_script("codex_review.sh", "HEAD", self.prompt, out, ok=False, MOCK_CODEX="bad-verdict")
        self.assertFalse(out.exists())

    def test_gemini_contract_and_failed_exit(self):
        out = self.task / "05-tests-gemini.md"
        self.run_script("ask_gemini.sh", self.prompt, out, "--contract-only")
        self.assertEqual(self.state(out), "succeeded")
        self.run_script("ask_gemini.sh", self.prompt, out, ok=False, MOCK_AGY="fail")
        self.assertFalse(out.exists())
        self.assertEqual(self.state(out), "failed")

    def test_secret_paths_and_doctor(self):
        secret = self.repo / "a/b/c/d/e/f/g/.env"
        secret.parent.mkdir(parents=True)
        secret.write_text("secret")
        (self.repo / ".geminiignore").write_text("./private.txt\n")
        result = self.run_script("doctor.sh")
        self.assertIn("a/b/c/d/e/f/g/.env", result.stdout)
        self.assertIn("private.txt", result.stdout)
        self.assertIn("MODE: full", result.stdout)
        (self.repo / ".geminiignore").write_text("*.secret\n")
        self.run_script("doctor.sh", ok=False)

    def test_timeout(self):
        result = subprocess.run([sys.executable, str(SCRIPTS / "run_timeout.py"), "1",
                                 sys.executable, "-c", "import time; time.sleep(30)"],
                                capture_output=True, timeout=8)
        self.assertEqual(result.returncode, 124)


if __name__ == "__main__":
    unittest.main()
