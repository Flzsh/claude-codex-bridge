#!/usr/bin/env python3
"""Run a command with a bounded lifetime, including its process group."""
import os
import signal
import subprocess
import sys


def main():
    seconds = int(sys.argv[1])
    proc = subprocess.Popen(sys.argv[2:], start_new_session=True)

    def stop(signum, _frame):
        raise InterruptedError(signum)

    def terminate():
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        # The leader may exit while descendants remain.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        code = proc.wait(timeout=seconds)
        return code if code >= 0 else 128 - code
    except subprocess.TimeoutExpired:
        terminate()
        print(f"ERROR: command timed out after {seconds}s", file=sys.stderr)
        return 124
    except InterruptedError as exc:
        terminate()
        return 128 + exc.args[0]


if __name__ == "__main__":
    sys.exit(main())
