#!/usr/bin/env bash
# Read a flat key: value setting. No shell evaluation or general YAML parsing.
key="${1:?usage: cfg.sh <key> [default]}"; def="${2-}"
root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
python3 - "$root/.multimodel/config.yaml" "$key" "$def" <<'PYCFG'
from pathlib import Path
import re
import sys

path, key, default = sys.argv[1:]
value = ""
if Path(path).is_file():
    for line in Path(path).read_text().splitlines():
        match = re.match(r"^\s*" + re.escape(key) + r":\s*(.*)$", line)
        if not match:
            continue
        value = match.group(1).strip()
        if value.startswith(('"', "'")):
            quote = value[0]
            end = value.rfind(quote)
            if end > 0 and re.fullmatch(r"\s*(?:#.*)?", value[end+1:]):
                value = value[1:end]
            else:
                print(f"ERROR: invalid quoted config value for {key}", file=sys.stderr)
                sys.exit(2)
        else:
            value = re.split(r"(?:^|\s+)#", value, maxsplit=1)[0].rstrip()
        break
print(value or default)
PYCFG
