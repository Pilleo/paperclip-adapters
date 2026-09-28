import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("scripts") / "jules_status.py"
SESSION = "13925655926969425884"


class JulesStatusTests(unittest.TestCase):
    def run_helper(self, cli_body: str, *, session: str = SESSION, key: str = "private-key"):
        with tempfile.TemporaryDirectory() as directory:
            cli = Path(directory) / "jules"
            cli.write_text("#!/bin/sh\n" + cli_body)
            cli.chmod(0o700)
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ.get("PATH", ""), "JULES_API_KEY": key}
            return subprocess.run(
                [sys.executable, str(SCRIPT), session],
                env=env, text=True, capture_output=True, timeout=10,
            )

    def test_reports_only_the_exact_session_summary_without_key(self):
        result = self.run_helper(
            "test -z \"$JULES_API_KEY\" || exit 8\n"
            "printf '%s\\n' 'ID    Description    Repo    Last active    State' "
            "' 139256559269694258840    Other session    private/repo    1m ago    Running' "
            "' 13925655926969425884    Canary A    Pilleo/repo    8m ago    Awaiting Plan A'\n"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["sessionId"], SESSION)
        self.assertEqual(payload["statusLabel"], "Awaiting Plan A")
        self.assertEqual(payload["lastActiveLabel"], "8m ago")
        self.assertEqual(payload["source"], "jules-cli")
        self.assertEqual(payload["detailLevel"], "list-summary")
        self.assertNotIn("private-key", result.stdout + result.stderr)
        self.assertNotIn("private/repo", result.stdout + result.stderr)

    def test_rejects_invalid_session_id_before_invoking_cli(self):
        result = self.run_helper("echo invoked >&2\n", session="../sessions?apiKey=private-key")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("invoked", result.stdout + result.stderr)
        self.assertNotIn("private-key", result.stdout + result.stderr)

    def test_cli_failure_never_leaks_stderr(self):
        result = self.run_helper("echo 'private-key provider error' >&2\nexit 9\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("private-key", result.stdout + result.stderr)
        self.assertIn("Jules CLI failed", result.stderr)

    def test_missing_session_does_not_guess_provider_state(self):
        result = self.run_helper("printf '%s\\n' 'ID    Description    Repo    Last active    State'\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Session not found", result.stderr)

    def test_unexpected_status_is_not_echoed(self):
        result = self.run_helper(
            "printf '%s\\n' ' 13925655926969425884    title    repo    now    private-key'\n"
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("private-key", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
