#!/usr/bin/env python3
"""Read the Trio task directory as a versioned JSON interface for a UI."""
import argparse
import json
from pathlib import Path
import re
import subprocess

TASK_ID = re.compile(r"[0-9]{8}-[a-zA-Z0-9-]+")

ARTIFACTS = {
    "request": ["00-request.md"],
    "understand": ["01-context.md", "01-scout-gemini.md"],
    "plan": ["02-plan-claude.md", "02-plan-gemini.md"],
    "synthesis": ["03-synthesis.md"],
    "design": ["04-design.md", "04-design-review-gemini.md"],
    "build": ["05-contract.md", "05-ticket-codex.md", "05-receipt-codex.md", "05-tests-gemini.md"],
    "verify": ["06-visual-qa-gemini.md", "06-visual-qa-r2-gemini.md", "07-integration.md"],
    "review": [],
}


def task_data(task):
    phases = []
    for name, files in ARTIFACTS.items():
        if name == "review":
            files = sorted({
                re.sub(r"\.run\.json$", "", p.name)
                for p in task.glob("08-review-codex-r*.md*")
                if re.fullmatch(r"08-review-codex-r\d+\.md(?:\.run\.json)?", p.name)
            })
        artifacts = []
        for filename in files:
            path = task / filename
            exists = path.is_file() and not path.is_symlink()
            status = {"path": filename, "present": exists, "bytes": path.stat().st_size if exists else 0}
            state_file = task / (filename + ".run.json")
            if state_file.is_file() and not state_file.is_symlink():
                try:
                    state = json.loads(state_file.read_text())
                    if state["schema_version"] != 1 or state["state"] not in {"running", "succeeded", "failed"}:
                        raise ValueError("invalid run state")
                    status["run"] = state
                except (ValueError, KeyError, TypeError, OSError):
                    status["run"] = {"state": "unknown"}
            artifacts.append(status)
        phases.append({"id": name, "artifacts": artifacts})
    return {"id": task.name, "path": str(task), "phases": phases}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task_id", nargs="?", help="task ID; omit to list tasks")
    parser.add_argument("--repo", type=Path, help="project root; default is current Git root")
    args = parser.parse_args()
    root = args.repo
    if root is None:
        result = subprocess.run(["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
        root = Path(result.stdout.strip()) if result.returncode == 0 else Path.cwd()
    tasks = root.resolve() / ".multimodel" / "tasks"
    if args.task_id:
        if not TASK_ID.fullmatch(args.task_id):
            parser.error("invalid task ID")
        task = tasks / args.task_id
        if not task.is_dir() or task.is_symlink():
            parser.error("task not found")
        print(json.dumps({"schema_version": 1, "task": task_data(task)}, indent=2))
    else:
        items = []
        if tasks.is_dir():
            for task in sorted(tasks.iterdir()):
                if task.is_dir() and not task.is_symlink() and TASK_ID.fullmatch(task.name):
                    items.append({"id": task.name, "path": str(task)})
        print(json.dumps({"schema_version": 1, "tasks": items}, indent=2))


if __name__ == "__main__":
    main()
