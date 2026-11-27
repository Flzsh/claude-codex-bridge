#!/usr/bin/env python3
"""Write an atomic, machine-readable result beside a workflow artifact."""
import datetime
import json
import os
from pathlib import Path
import sys
import tempfile


def main():
    path, state, code = sys.argv[1:]
    target = Path(path + ".run.json")
    data = {
        "schema_version": 1,
        "state": state,
        "exit_code": int(code) if code else None,
        "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }
    with tempfile.NamedTemporaryFile(mode="w", dir=target.parent, delete=False) as f:
        tmp = f.name
        json.dump(data, f, indent=2)
        f.write("\n")
    try:
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


if __name__ == "__main__":
    main()
