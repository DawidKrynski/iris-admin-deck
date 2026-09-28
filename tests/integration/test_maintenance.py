"""Integration tests for maintenance flows: audit copy / purge.

Audit data is never really removed here: copy and purge run on a far-past range (before the instance
existed), which exercises the background task and its read-back without touching real records.

    python3 -m unittest discover -s tests/integration -p 'test_maintenance.py' -v

Standard library only.
"""
import unittest

from test_api import Client

FAR_PAST = {"BeginDateTime": "", "EndDateTime": "2000-01-01 00:00:00"}


class AuditMaintenance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = Client("/api/admin")
        assert cls.api.token, "JWT login to /api/admin failed"

    def records(self, **query):
        """Records in a range, as the UI counts them (the API has no count call)."""
        return self.api.wait(self.api.ok("POST", "/v2/security/audit/records", {"maxRows": 10000, "ascending": 1, **query}, {}))["Result"]

    def test_audit_database_and_range(self):
        audit = next(d for d in self.api.get("/v2/databases") if d["Name"] == "IRISAUDIT")
        size = next(d for d in self.api.get("/v2/database-dirs") if d["Directory"] == audit["Directory"])["Size"]
        self.assertGreater(size, 0)
        oldest = self.records()[0]
        # Records carry the server-time TimeStamp the purge range is given in.
        self.assertRegex(oldest["TimeStamp"], r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}")

    def test_purge_far_past_is_verified_and_keeps_the_trail(self):
        before = len(self.records())
        task = self.api.wait(self.api.ok("POST", "/v2/security/audit/record/purge", body=FAR_PAST))
        self.assertEqual(task["State"], "Finished")
        # Read-back as in the UI: nothing left up to the cutoff, the rest untouched (queries add records, never remove).
        self.assertEqual(self.records(endDateTime=FAR_PAST["EndDateTime"]), [])
        self.assertGreaterEqual(len(self.records()), before)

    def test_copy(self):
        body = {"AuditCopyNamespace": "USER", "DeleteAfterCopy": False, **FAR_PAST}
        self.assertEqual(self.api.wait(self.api.ok("POST", "/v2/security/audit/record/copy", body=body))["State"], "Finished")
        # Bad input is accepted with 202 and only fails in the background task: the UI must check the task state.
        bad = self.api.wait(self.api.ok("POST", "/v2/security/audit/record/copy", body={**body, "AuditCopyNamespace": "ZZNOSUCHNS"}))
        self.assertEqual(bad["State"], "Failed")
        self.assertIn("NAMESPACE", bad["FailureReason"])
        bad = self.api.wait(self.api.ok("POST", "/v2/security/audit/record/purge", body={"BeginDateTime": "", "EndDateTime": "not a date"}))
        self.assertEqual(bad["State"], "Failed")


if __name__ == "__main__":
    unittest.main()
