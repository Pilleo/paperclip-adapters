#!/usr/bin/env python3
"""Read one Jules session and its activities; keep the local API key in memory."""

import argparse
import json
import os
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


API_BASE = "https://jules.googleapis.com/v1alpha"
ENV_FILE = Path(__file__).resolve().parents[4] / ".ENV"
STATES = frozenset({"QUEUED", "PLANNING", "IN_PROGRESS", "PAUSED", "AWAITING_USER_FEEDBACK",
                    "AWAITING_PLAN_APPROVAL", "COMPLETED", "FAILED"})
KINDS = ("userMessaged", "agentMessaged", "planGenerated", "planApproved",
         "progressUpdated", "sessionCompleted", "sessionFailed")
DATE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$")
KEY_LINE = re.compile(r"^\s*(?:export\s+)?JULES_API_KEY\s*=\s*(.*?)\s*$")


class SafeJulesError(Exception):
    """An error with no credential or untrusted provider content."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        raise SafeJulesError("Jules API redirected; refusing to forward credentials.")


def load_key(env_file: Path) -> str:
    try:
        fd = os.open(env_file, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise SafeJulesError("Cannot open the local .ENV credential file.") from None
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077 or info.st_size > 131072):
            raise SafeJulesError(".ENV permissions must be owner-only (chmod 600), with no symlink.")
        with os.fdopen(fd, "r", encoding="utf-8") as stream:
            fd = -1
            lines = stream.readlines()
    except (OSError, UnicodeError):
        raise SafeJulesError("Cannot read the local .ENV credential file.") from None
    finally:
        if fd != -1:
            os.close(fd)

    keys = [match.group(1) for line in lines if (match := KEY_LINE.fullmatch(line.rstrip("\n")))]
    if len(keys) != 1:
        raise SafeJulesError("Expected exactly one JULES_API_KEY entry in .ENV.")
    key = keys[0].strip().strip("\r")
    if key[:1] in ("'", '"') and key[-1:] == key[:1]:
        key = key[1:-1]
    if not key or any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise SafeJulesError("JULES_API_KEY in .ENV is empty or malformed.")
    return key


def safe_date(value):
    return value if isinstance(value, str) and DATE.fullmatch(value) else None


def read_session(session_id: str, env_file: Path, *, base_url: str = API_BASE,
                 feedback_phrase: str | None = None) -> dict:
    if not re.fullmatch(r"[0-9]{1,30}", session_id):
        raise SafeJulesError("Provide exactly one numeric Jules session ID.")
    key = load_key(env_file)
    opener = urllib.request.build_opener(NoRedirect())

    def get(path: str) -> dict:
        request = urllib.request.Request(base_url + path, headers={"X-Goog-Api-Key": key}, method="GET")
        try:
            with opener.open(request, timeout=30) as response:
                if response.status != 200:
                    raise SafeJulesError("Jules API returned an unexpected status.")
                data = response.read(1048577)
            if len(data) > 1048576:
                raise SafeJulesError("Jules API response exceeds the read limit.")
            result = json.loads(data)
        except urllib.error.HTTPError as error:
            raise SafeJulesError(f"Jules API returned HTTP {error.code}.") from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise SafeJulesError("Jules API request failed or returned invalid JSON.") from None
        if not isinstance(result, dict):
            raise SafeJulesError("Jules API returned an invalid response.")
        return result

    session = get(f"/sessions/{session_id}")
    state = session.get("state")
    if session.get("name") != f"sessions/{session_id}" or state not in STATES:
        raise SafeJulesError("Jules session identity or state is invalid.")
    report = {"sessionId": session_id, "state": state, "updatedAt": safe_date(session.get("updateTime")),
              "source": "jules-api", "activities": []}
    page_token = None
    seen_tokens = set()
    feedback_seen = False
    for _ in range(20):
        query = urllib.parse.urlencode({"pageSize": 100, **({"pageToken": page_token} if page_token else {})})
        page = get(f"/sessions/{session_id}/activities?{query}")
        activities = page.get("activities", [])
        if not isinstance(activities, list):
            raise SafeJulesError("Jules activities response is invalid.")
        for activity in activities:
            if not isinstance(activity, dict):
                raise SafeJulesError("Jules activity is invalid.")
            kind = next((name for name in KINDS if name in activity), "other")
            record = {"kind": kind, "createdAt": safe_date(activity.get("createTime"))}
            if kind == "planGenerated":
                plan = activity.get("planGenerated")
                steps = plan.get("plan", {}).get("steps") if isinstance(plan, dict) and isinstance(plan.get("plan"), dict) else None
                if isinstance(steps, list):
                    record["planStepCount"] = len(steps)
            if kind == "userMessaged" and feedback_phrase:
                message = activity["userMessaged"]
                if isinstance(message, dict) and isinstance(message.get("userMessage"), str):
                    feedback_seen |= feedback_phrase.casefold() in message["userMessage"].casefold()
            report["activities"].append(record)
        page_token = page.get("nextPageToken")
        if page_token is None or page_token == "":
            break
        if not isinstance(page_token, str) or page_token in seen_tokens:
            raise SafeJulesError("Jules activities pagination is invalid.")
        seen_tokens.add(page_token)
    else:
        raise SafeJulesError("Jules activities exceed the pagination limit; no complete report available.")
    if feedback_phrase:
        report["feedbackSeenInUserMessage"] = feedback_seen
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Read Jules session and activities without exposing JULES_API_KEY")
    parser.add_argument("session_id")
    parser.add_argument("--contains-feedback", metavar="PHRASE", help="Check user messages for a phrase without printing messages")
    arguments = parser.parse_args()
    try:
        report = read_session(arguments.session_id, ENV_FILE, feedback_phrase=arguments.contains_feedback)
    except SafeJulesError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
