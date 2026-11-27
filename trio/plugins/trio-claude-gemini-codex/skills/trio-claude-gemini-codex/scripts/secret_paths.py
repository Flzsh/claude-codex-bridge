#!/usr/bin/env python3
"""Enumerate likely secret files and literal Gemini exclusions."""
import fnmatch
import os
from pathlib import Path
import sys

PATTERNS = (
    ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ecdsa*",
    "id_ed25519*", "credentials", "credentials*.json", "service-account*.json",
    ".npmrc", ".pypirc", ".netrc", ".git-credentials", ".htpasswd", ".pgpass",
    "secret*.json", "secret*.yml", "secret*.yaml", "*.tfvars", "*.tfstate", "*.tfstate.backup",
    "*.keystore", "*.jks", "*.kdbx", "*.sqlite", "*.sqlite3",
)
EXAMPLES = {".env.example", ".env.sample", ".env.template"}
# The repository's own settings: a remote URL can carry a token.
GIT_FILES = (".git/config",)
PRUNED = {".git", "node_modules", ".multimodel", ".venv", "venv"}


def fail(error):
    raise error


def main():
    root = Path(sys.argv[1]).resolve()
    paths = set()
    for directory, dirs, files in os.walk(root, onerror=fail):
        dirs[:] = [name for name in dirs if name not in PRUNED]
        for name in files:
            # matched whatever the letter case (macOS folders usually ignore it)
            lower = name.lower()
            if lower not in EXAMPLES and any(fnmatch.fnmatchcase(lower, p) for p in PATTERNS):
                paths.add(str((Path(directory) / name).relative_to(root)))
    for name in GIT_FILES:
        if (root / name).is_file():
            paths.add(name)
    ignore = root / ".geminiignore"
    if ignore.is_file():
        for line in ignore.read_text().splitlines():
            entry = line.strip()
            if not entry or entry.startswith("#"):
                continue
            if any(c in entry for c in "*?[]") or entry.startswith("!"):
                print(f"ERROR: .geminiignore supports literal file paths only: {entry}", file=sys.stderr)
                return 1
            target = Path(os.path.abspath(root / entry))
            if target.is_dir():
                print(f"ERROR: list individual files in .geminiignore: {entry}", file=sys.stderr)
                return 1
            try:
                paths.add(str(target.relative_to(root)))
            except ValueError:
                paths.add(str(target))
    for path in sorted(paths):
        if "\n" in path or "\r" in path:
            print("ERROR: newline in secret path", file=sys.stderr)
            return 1
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
