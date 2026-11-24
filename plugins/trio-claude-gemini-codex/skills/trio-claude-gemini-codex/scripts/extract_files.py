#!/usr/bin/env python3
"""Write the files a model proposed in its answer into the repo.

Usage:
  extract_files.py <answer.md> <allowed-dir> [--dry-run]

The answer must use the format from prompts/test-author.md:

  ### FILE: test/acceptance/api.acceptance.test.js
  ```js
  ...file contents...
  ```

Only paths inside <allowed-dir> (relative to the repo root, e.g. "test/acceptance") are
written; anything else (absolute paths, "..", other folders) is refused, because the answer
came from another model and is untrusted. Existing files are overwritten. Prints each file
written with its line count.
"""
import os
import re
import subprocess
import sys


def repo_root():
    try:
        return subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True, stderr=subprocess.DEVNULL).strip()
    except Exception:
        return os.getcwd()


def main(argv):
    if len(argv) < 2 or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 2
    answer, allowed, dry = argv[0], argv[1].strip("/"), "--dry-run" in argv[2:]
    root = repo_root()
    allowed_abs = os.path.realpath(os.path.join(root, allowed))
    with open(answer, encoding="utf-8") as f:
        text = f.read()

    parts = re.split(r"^#{2,4} FILE:\s*`?([^`\n]+?)`?\s*$", text, flags=re.M)
    if len(parts) < 3:
        print("ERROR: no '### FILE: <path>' sections found", file=sys.stderr)
        return 1
    written, refused = 0, 0
    for i in range(1, len(parts), 2):
        rel, body = parts[i].strip(), parts[i + 1]
        m = re.search(r"```[^\n]*\n(.*?)\n```", body, flags=re.S)
        target = os.path.realpath(os.path.join(root, rel))
        if os.path.isabs(rel) or not (target == allowed_abs or target.startswith(allowed_abs + os.sep)):
            print(f"REFUSED (outside {allowed}/): {rel}", file=sys.stderr)
            refused += 1
            continue
        if not m:
            print(f"REFUSED (no code block): {rel}", file=sys.stderr)
            refused += 1
            continue
        content = m.group(1) + "\n"
        if not dry:
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "w", encoding="utf-8") as f:
                f.write(content)
        print(f"{'WOULD WRITE' if dry else 'WROTE'} {rel} ({content.count(chr(10))} lines)")
        written += 1
    print(f"{written} file(s) {'found' if dry else 'written'}, {refused} refused")
    return 0 if written and not refused else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
