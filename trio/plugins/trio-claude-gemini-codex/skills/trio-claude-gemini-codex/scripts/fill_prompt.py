#!/usr/bin/env python3
"""Fill a prompt template's {{PLACEHOLDERS}} and save the result.

Usage:
  fill_prompt.py <template> <out-file> KEY=value KEY=@path/to/file ... [--append TEXT|@file]

<template> is a name from this skill's prompts/ folder (e.g. "plan" or "codex-review")
or a path. A value starting with @ is read from that file. --append adds text (or a
file's contents) at the end, e.g. a "Round 2" note. Fails if any {{PLACEHOLDER}} is left
unfilled, so a half-filled prompt never reaches another model.
"""
import os
import re
import sys

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_value(raw):
    if raw.startswith("@"):
        with open(raw[1:], encoding="utf-8") as f:
            return f.read().rstrip("\n")
    return raw


def main(argv):
    if len(argv) < 2 or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return 2
    template, out, rest = argv[0], argv[1], argv[2:]
    builtin = os.path.join(SKILL_DIR, "prompts", f"{os.path.basename(template).removesuffix('.md')}.md")
    is_name = os.sep not in template and "/" not in template
    # A bare name is always this skill's own prompt, so a file of that name in the project (a
    # cloned repo's "codex-review", say) can never stand in for it; a path is used as given.
    if is_name and os.path.isfile(builtin):
        path = builtin
    elif not is_name and os.path.isfile(template):
        path = template
    else:
        path = builtin
    if not os.path.isfile(path):
        print(f"ERROR: template not found: {template}", file=sys.stderr)
        return 1
    with open(path, encoding="utf-8") as f:
        text = f.read()

    appends = []
    i = 0
    while i < len(rest):
        arg = rest[i]
        if arg == "--append":
            if i + 1 >= len(rest):
                print("ERROR: --append needs a value", file=sys.stderr)
                return 1
            appends.append(read_value(rest[i + 1]))
            i += 2
            continue
        if "=" not in arg:
            print(f"ERROR: expected KEY=value, got: {arg}", file=sys.stderr)
            return 1
        key, value = arg.split("=", 1)
        token = "{{" + key.strip().upper() + "}}"
        if token not in text:
            print(f"WARNING: {token} is not in {os.path.basename(path)}", file=sys.stderr)
        text = text.replace(token, read_value(value))
        i += 1

    for extra in appends:
        text = text.rstrip("\n") + "\n\n" + extra + "\n"

    left = sorted(set(re.findall(r"\{\{[A-Z0-9_]+\}\}", text)))
    if left:
        print(f"ERROR: unfilled placeholders: {', '.join(left)}", file=sys.stderr)
        return 1
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"OK: wrote {out} ({len(text):,} chars)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
