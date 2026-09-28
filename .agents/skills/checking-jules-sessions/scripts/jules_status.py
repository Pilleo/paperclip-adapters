#!/usr/bin/env python3
"""Read one Jules session summary via the authenticated Jules CLI; never handle its API key."""

import json
import os
import re
import subprocess
import sys


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(r"[0-9]{1,30}", sys.argv[1]):
        print("Provide exactly one numeric Jules session ID.", file=sys.stderr)
        return 2

    session_id = sys.argv[1]
    # The CLI uses its own login. Do not forward an unrelated Jules API key or
    # allow it to enter an error message, child environment, or process arguments.
    env = {key: value for key, value in os.environ.items()
           if key not in ("JULES_API_KEY", "GOOGLE_API_KEY")}
    try:
        completed = subprocess.run(
            ["jules", "remote", "list", "--session"],
            env=env, capture_output=True, text=True, timeout=30, check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        print("Jules CLI unavailable or timed out; no session state verified.", file=sys.stderr)
        return 1
    if completed.returncode != 0:
        # CLI stderr can contain provider data; never relay it to logs or users.
        print("Jules CLI failed; no session state verified.", file=sys.stderr)
        return 1

    for line in completed.stdout.splitlines():
        columns = re.split(r"\s{2,}", line.strip(), maxsplit=4)
        if len(columns) != 5 or columns[0] != session_id:
            continue
        if not re.match(r"^(?:Awaiting|Running|In Progress|Planning|Pending|Completed|Failed|Cancel(?:led|ed))\b", columns[4]):
            print("Jules CLI returned an unrecognized status; no session state verified.", file=sys.stderr)
            return 1
        print(json.dumps({
            "sessionId": session_id,
            "statusLabel": columns[4],
            "lastActiveLabel": columns[3],
            "source": "jules-cli",
            "detailLevel": "list-summary",
            "limitation": "CLI status labels may be truncated; this does not show plan content or prove feedback was received.",
        }))
        return 0

    print("Session not found in Jules CLI listing; no session state verified.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
