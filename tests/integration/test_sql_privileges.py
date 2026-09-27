"""Integration tests for the SQL privilege flows of the Roles screen (grant, read back, revoke).

The SysAdmin API cannot create tables, so the privileges are granted on the Admin Deck's own table
AdminDeck_Data.LogLine in USER, to a throw-away role zzSqlTest<run id>. Deleting the role at the end
also removes every SQL privilege it still holds.

    python3 -m unittest discover -s tests/integration -p 'test_sql_privileges.py' -v

Standard library only.
"""
import os
import unittest

from test_api import Client

NAMESPACE = "USER"
TABLE = "AdminDeck_Data.LogLine"
ROLE = f"zzSqlTest{os.getpid()}"


class SqlPrivileges(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.api = Client("/api/admin")
        assert cls.api.token, "JWT login to /api/admin failed"
        catalog = cls.api.get("/v2/security/sql-privileges", grantee="SuperUser", namespace=NAMESPACE, maxRows=100000)
        if not any(r["Type"] == "TABLE" and r["Object"] == TABLE for r in catalog):
            raise unittest.SkipTest(f"{TABLE} does not exist in {NAMESPACE}")
        cls.api.ok("PUT", "/v2/security/role", {"name": ROLE}, {"Description": "SQL privilege integration test"})

    @classmethod
    def tearDownClass(cls):
        cls.api.call("DELETE", "/v2/security/role", {"name": ROLE})

    def post(self, path, **query):
        return self.api.ok("POST", path, {"namespace": NAMESPACE, "grantee": ROLE, **query}, {})

    def objects(self):
        rows = self.api.get("/v2/security/sql-privileges", grantee=ROLE, namespace=NAMESPACE)
        return {(r["Type"], r["Object"], r["Action"]): r for r in rows if r["GrantedVia"] != "Owner Privilege"}

    def test_object_privilege_grant_and_revoke(self):
        target = {"type": "TABLE", "object": TABLE}
        self.post("/v2/security/sql-privilege/grant", **target, action="SELECT", withGrant=1)
        self.post("/v2/security/sql-privilege/grant", **target, action="INSERT")
        held = self.objects()
        # The list uses Object/Action, not the Name/Privilege fields of the OpenAPI spec.
        self.assertEqual(held[("TABLE", TABLE, "SELECT")]["GrantedVia"], "Direct")
        self.assertTrue(held[("TABLE", TABLE, "SELECT")]["GrantOption"])
        self.assertFalse(held[("TABLE", TABLE, "INSERT")]["GrantOption"])
        check = {"namespace": NAMESPACE, "grantee": ROLE, **target, "action": "SELECT"}
        self.assertEqual(self.api.call("HEAD", "/v2/security/sql-privilege", check).status, 200)

        for action in ("SELECT", "INSERT"):
            self.post("/v2/security/sql-privilege/revoke", **target, action=action)
        held = self.objects()
        self.assertNotIn(("TABLE", TABLE, "SELECT"), held)
        self.assertNotIn(("TABLE", TABLE, "INSERT"), held)
        self.assertEqual(self.api.call("HEAD", "/v2/security/sql-privilege", check).status, 404)

    def test_schema_privilege_is_listed_per_table(self):
        schema = TABLE.split(".")[0]
        self.post("/v2/security/sql-privilege/grant", type="SCHEMA", object=schema, action="SELECT")
        try:
            row = self.objects().get(("TABLE", TABLE, "SELECT"))
            self.assertIsNotNone(row, "a schema grant shows up on the tables of the schema")
            self.assertEqual(row["GrantedVia"], "Schema Privilege")
        finally:
            self.post("/v2/security/sql-privilege/revoke", type="SCHEMA", object=schema, action="SELECT")
        self.assertNotIn(("TABLE", TABLE, "SELECT"), self.objects())

    def test_admin_privilege_grant_and_revoke(self):
        admin = lambda: {r["Privilege"]: r for r in self.api.get("/v2/security/sql-admin-privileges", grantee=ROLE, namespace=NAMESPACE)}
        self.post("/v2/security/sql-admin-privilege/grant", privilege="%CREATE_TABLE")
        self.assertEqual(admin()["%CREATE_TABLE"]["GrantedVia"], "Direct")
        self.post("/v2/security/sql-admin-privilege/revoke", privilege="%CREATE_TABLE")
        self.assertNotIn("%CREATE_TABLE", admin())
        # One privilege per call: a comma-separated list is rejected.
        r = self.api.call("POST", "/v2/security/sql-admin-privilege/grant",
                          {"namespace": NAMESPACE, "grantee": ROLE, "privilege": "%DROP_TABLE,%ALTER_TABLE"}, {})
        self.assertEqual(r.status, 400)

    def test_column_privilege_grant_and_revoke(self):
        column = {"type": "TABLE", "object": TABLE, "column": "Severity", "action": "UPDATE"}
        columns = lambda: {(r["Column"], r["Action"]): r for r in self.api.get(
            "/v2/security/sql-column-privileges", grantee=ROLE, namespace=NAMESPACE, object=TABLE)}
        self.post("/v2/security/sql-column-privilege/grant", **column)
        self.assertEqual(columns()[("Severity", "UPDATE")]["GrantedVia"], "Direct")
        # The table list flags the table with an empty Action and HasColumnPriv.
        self.assertTrue(any(r["HasColumnPriv"] for (t, o, a), r in self.objects().items() if o == TABLE))
        self.post("/v2/security/sql-column-privilege/revoke", **column)
        self.assertNotIn(("Severity", "UPDATE"), columns())

    def test_unknown_column_is_accepted_but_not_granted(self):
        # IRIS answers 200 and records nothing: only reading the privileges back shows it.
        self.post("/v2/security/sql-column-privilege/grant", type="TABLE", object=TABLE, column="NoSuchColumn", action="SELECT")
        rows = self.api.get("/v2/security/sql-column-privileges", grantee=ROLE, namespace=NAMESPACE, object=TABLE)
        self.assertEqual([r for r in rows if r["Column"].upper() == "NOSUCHCOLUMN"], [])

    def test_grant_errors(self):
        base = {"namespace": NAMESPACE, "grantee": ROLE, "type": "TABLE", "object": TABLE, "action": "SELECT"}
        missing = self.api.call("POST", "/v2/security/sql-privilege/grant", {**base, "object": "No_Such.Table"}, {})
        self.assertNotEqual(missing.status, 200)
        self.assertTrue(any("not found" in str(e.get("error", "")) for e in missing.errors))
        nobody = self.api.call("POST", "/v2/security/sql-privilege/grant", {**base, "grantee": f"{ROLE}Missing"}, {})
        self.assertNotEqual(nobody.status, 200)


if __name__ == "__main__":
    unittest.main()
