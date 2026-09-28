import importlib.util
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


SCRIPT = Path(__file__).with_name("scripts") / "jules_api.py"
SESSION = "13925655926969425884"
KEY = "test-private-jules-key"


class JulesApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("jules_api", SCRIPT)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls.api = module

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env_file = Path(self.directory.name) / ".ENV"
        self.env_file.write_text("OTHER_KEY=some-value\nJULES_API_KEY=" + KEY + "\n")
        self.env_file.chmod(0o600)

    def tearDown(self):
        self.directory.cleanup()

    def test_reads_live_session_and_paginated_activities_without_exposing_key_or_message(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get("X-Goog-Api-Key")))
                if self.path == f"/v1alpha/sessions/{SESSION}":
                    data = {"name": f"sessions/{SESSION}", "state": "AWAITING_PLAN_APPROVAL",
                            "updateTime": "2026-09-26T18:37:51Z", "prompt": KEY}
                elif self.path.endswith("/activities?pageSize=100"):
                    data = {"activities": [{"id": "1", "createTime": "2026-09-26T18:36:00Z",
                            "userMessaged": {"userMessage": "Please revise the plan " + KEY}}], "nextPageToken": "next"}
                elif self.path.endswith("/activities?pageSize=100&pageToken=next"):
                    data = {"activities": [{"id": "2", "createTime": "2026-09-26T18:37:00Z",
                            "planGenerated": {"plan": {"steps": [{"title": KEY}]}}}]}
                else:
                    self.send_error(404)
                    return
                payload = json.dumps(data).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            report = self.api.read_session(SESSION, self.env_file,
                base_url=f"http://127.0.0.1:{server.server_port}/v1alpha",
                feedback_phrase="Please revise the plan")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(report["state"], "AWAITING_PLAN_APPROVAL")
        self.assertEqual(report["activities"][0]["kind"], "userMessaged")
        self.assertEqual(report["activities"][1]["kind"], "planGenerated")
        self.assertTrue(report["feedbackSeenInUserMessage"])
        self.assertEqual(len(requests), 3)
        self.assertTrue(all(key == KEY for _, key in requests))
        self.assertNotIn(KEY, json.dumps(report))

    def test_rejects_group_readable_credentials_before_request(self):
        self.env_file.chmod(0o664)
        with self.assertRaisesRegex(self.api.SafeJulesError, "permissions") as error:
            self.api.read_session(SESSION, self.env_file)
        self.assertNotIn(KEY, str(error.exception))

    def test_rejects_path_instead_of_session_id(self):
        with self.assertRaisesRegex(self.api.SafeJulesError, "numeric"):
            self.api.read_session("../../sessions?key=" + KEY, self.env_file)

    def test_does_not_include_secret_in_http_failure(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(403)
                self.end_headers()
                self.wfile.write(("rejected " + KEY).encode())

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with self.assertRaises(self.api.SafeJulesError) as error:
                self.api.read_session(SESSION, self.env_file,
                    base_url=f"http://127.0.0.1:{server.server_port}/v1alpha")
            self.assertNotIn(KEY, str(error.exception))
            self.assertIn("403", str(error.exception))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
