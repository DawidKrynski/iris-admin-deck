"""Integration tests for the Language servers screen: create, edit, start, stop and delete a throw-away
Python gateway named zzApiTest<run id> (removed again even when a test fails; built-in servers are only read).

    python3 -m unittest discover -s tests/integration -p 'test_language_servers.py' -v

Standard library only.
"""
import os
import unittest

from test_api import PREFIX, Client

NAME = {"name": f"{PREFIX}Python"}
PORT = 55000 + os.getpid() % 1000


class LanguageServers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = Client("/api/admin")
        assert cls.api.token, "JWT login to /api/admin failed"

    def tearDown(self):
        if self.api.call("GET", "/v2/ext-lang-server", NAME).status == 200:
            self.api.call("POST", "/v2/ext-lang-server/stop", NAME, {})
            self.api.call("DELETE", "/v2/ext-lang-server", NAME)

    def running(self):
        return self.api.get("/v2/ext-lang-server/activity", maxRows=1, **NAME)["CurrentlyRunning"]

    def test_list_and_builtin_details(self):
        rows = self.api.get("/v2/ext-lang-servers")
        python = next(r for r in rows if r["Type"] == "Python")
        server = self.api.get("/v2/ext-lang-server", name=python["Name"])
        self.assertEqual(server["Port"], python["Port"])
        self.assertIn("PythonPath", server["Custom"])
        self.assertIsInstance(self.api.get("/v2/ext-lang-server/activity", name=python["Name"], maxRows=1)["CurrentlyRunning"], bool)

    def test_lifecycle(self):
        self.api.ok("PUT", "/v2/ext-lang-server", NAME, {"Type": "Python", "Port": PORT, "Resource": "%Gateway_Object"})
        self.assertEqual(self.api.get("/v2/ext-lang-server", **NAME)["Port"], PORT)
        # IRIS 2026.2 quirk: an update without Type is refused, so the UI always sends it.
        self.assertEqual(self.api.call("PUT", "/v2/ext-lang-server", NAME, {"ConnectionTimeout": 7}).errors[0]["id"], "MissingRequestBodyField")
        self.api.ok("PUT", "/v2/ext-lang-server", NAME, {"Type": "Python", "ConnectionTimeout": 7, "Custom": {"PythonOptions": "-u", "PythonPath": ""}})
        server = self.api.get("/v2/ext-lang-server", **NAME)
        self.assertEqual((server["ConnectionTimeout"], server["Custom"]["PythonOptions"]), (7, "-u"))

        self.assertFalse(self.running())
        self.api.ok("POST", "/v2/ext-lang-server/start", NAME, {})
        self.assertTrue(self.running())
        self.api.ok("POST", "/v2/ext-lang-server/stop", NAME, {})
        self.assertFalse(self.running())

        self.api.ok("DELETE", "/v2/ext-lang-server", NAME)
        self.assertEqual(self.api.call("GET", "/v2/ext-lang-server", NAME).status, 404)


if __name__ == "__main__":
    unittest.main()
