"""Integration tests against a running IRIS Admin Deck instance.

Covers the SysAdmin endpoints the UI reads, the main write flows the UI performs (on throw-away
objects named zzApiTest<run id>, removed again even when a test fails), the extension API and
security properties.

    python3 -m unittest discover -s tests/integration -v
    IRIS_BASE=http://localhost:52785 IRIS_USER=SuperUser IRIS_PASSWORD=SYS python3 -m unittest ...

Standard library only.
"""
import json
import os
import subprocess
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("IRIS_BASE", "http://127.0.0.1:52785").rstrip("/")
USER = os.environ.get("IRIS_USER", "SuperUser")
PASSWORD = os.environ.get("IRIS_PASSWORD", "SYS")
PREFIX = f"zzApiTest{os.getpid()}"  # unique per run: cleanup never touches another run's objects


class Response:
    def __init__(self, status, headers, body):
        self.status, self.headers = status, headers
        try:
            self.json = json.loads(body) if body else None
        except ValueError:
            self.json = None
        self.text = body

    @property
    def result(self):
        return (self.json or {}).get("result")

    @property
    def errors(self):
        return ((self.json or {}).get("status") or {}).get("errors") or []


class Client:
    """Minimal JWT client for one web application (/api/admin or /admindeck/api)."""

    def __init__(self, app, user=USER, password=PASSWORD):
        self.app = app
        login = raw("POST", f"{app}/login", body={"user": user, "password": password})
        self.token = (login.json or {}).get("access_token")
        self.refresh_token = (login.json or {}).get("refresh_token")

    def call(self, method, path, query=None, body=None):
        headers = {"Authorization": f"Bearer {self.token}"} if self.token else {}
        return raw(method, f"{self.app}{path}", query=query, body=body, headers=headers)

    def ok(self, method, path, query=None, body=None):
        r = self.call(method, path, query, body)
        if r.status not in (200, 201, 202) or r.errors:
            raise AssertionError(f"{method} {path} {query or ''} -> {r.status} {r.errors or r.text[:200]}")
        return r

    def get(self, path, **query):
        return self.ok("GET", path, query).result

    def wait(self, response, timeout=60):
        """Follows a 202 Accepted background task to its final state (Location header carries the id)."""
        location = response.headers.get("Location") or ""
        guid = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query).get("id", [None])[0]
        assert guid, f"202 without task id in Location: {location!r}"
        deadline = time.time() + timeout
        while time.time() < deadline:
            task = self.get("/v2/async-result", id=guid)
            if task.get("State") in ("Finished", "Failed", "Cancelled", "Error"):
                return task
            time.sleep(0.5)
        raise AssertionError(f"background task {guid} did not finish")


def raw(method, path, query=None, body=None, headers=None):
    url = BASE + path + ("?" + urllib.parse.urlencode(query) if query else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Accept": "application/json", **({"Content-Type": "application/json"} if data else {}), **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return Response(res.status, res.headers, res.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return Response(e.code, e.headers, e.read().decode("utf-8", "replace"))


def first(rows, key):
    assert rows, "expected a non-empty list"
    return rows[0][key]


class ReadEndpoints(unittest.TestCase):
    """Every SysAdmin endpoint the UI reads answers 200 with the documented envelope."""

    @classmethod
    def setUpClass(cls):
        cls.api = Client("/api/admin")
        assert cls.api.token, "JWT login to /api/admin failed"

    def test_lists(self):
        for path in ["/v2/web-apps", "/v2/security/users", "/v2/security/roles", "/v2/security/resources",
                     "/v2/security/services", "/v2/wallet/collections", "/v2/security/x509-credentials",
                     "/v2/security/ssl-configurations", "/v2/security/oauth2/client/server-definitions",
                     "/v2/security/oauth2/resource-servers", "/v2/tasks", "/v2/task/history", "/v2/task/upcoming",
                     "/v2/processes", "/v2/locks", "/v2/web-sessions", "/v2/databases", "/v2/database-dirs",
                     "/v2/namespaces", "/v2/devices", "/v2/journal/files", "/v2/async-results",
                     "/v2/security/audit/events"]:
            with self.subTest(path=path):
                self.assertIsInstance(self.api.get(path), list)

    def test_objects(self):
        for path in ["/v2/monitor/dashboard/main", "/v2/monitor/license-usage", "/v2/task/manager",
                     "/v2/journal/settings", "/v2/device/settings", "/v2/license/key", "/v2/security/audit/enabled"]:
            with self.subTest(path=path):
                self.assertIsNotNone(self.api.get(path))
        info = self.api.ok("GET", "/info").result
        self.assertIn("privileges", info)

    def test_details_of_first_items(self):
        self.assertIn("DispatchClass", self.api.get("/v2/web-app", name=first(self.api.get("/v2/web-apps"), "Name")))
        self.assertIn("Roles", self.api.get("/v2/security/user", name="SuperUser"))
        role = first(self.api.get("/v2/security/roles"), "Name")
        self.assertIn("Resources", self.api.get("/v2/security/role", name=role))
        self.assertIsNotNone(self.api.get("/v2/security/role/owners", name=role))
        self.assertIsNotNone(self.api.get("/v2/security/resource", name=first(self.api.get("/v2/security/resources"), "Name")))
        self.assertIsNotNone(self.api.get("/v2/security/service", name="%Service_WebGateway"))
        task = first(self.api.get("/v2/tasks"), "Id")
        self.assertIn("TaskClass", self.api.get("/v2/task", id=task))
        self.assertIn("Suspended", self.api.get("/v2/task/info", id=task))
        pid = first(self.api.get("/v2/processes"), "Pid")
        self.assertIn("JobNumber", self.api.get("/v2/process", id=pid))
        self.assertIsNotNone(self.api.get("/v2/device", name=first(self.api.get("/v2/devices"), "Name")))
        self.assertIsNotNone(self.api.get("/v2/security/ssl-configuration", name=first(self.api.get("/v2/security/ssl-configurations"), "Name")))
        for cred in self.api.get("/v2/security/x509-credentials")[:1]:
            self.assertIsNotNone(self.api.get("/v2/security/x509-credential/certificate", alias=cred["Alias"]))
        self.assertIsInstance(self.api.get("/v2/security/sql-privileges", grantee="SuperUser", namespace="USER"), list)

    def test_background_operations(self):
        user_db = next(d["Directory"] for d in self.api.get("/v2/database-dirs") if d["Directory"].rstrip("/").endswith("user"))
        info = self.api.ok("POST", "/v2/database-dir/info", {"dir": user_db}, {})
        self.assertEqual(info.status, 202)
        self.assertEqual(self.api.wait(info)["State"], "Finished")
        audit = self.api.ok("POST", "/v2/security/audit/records", {"maxRows": 5, "ascending": 0}, {})
        self.assertIsInstance(self.api.wait(audit)["Result"], list)
        check = self.api.ok("POST", "/v2/database-dir/integrity-check", body={"Databases": [{"Directory": user_db}]})
        task = self.api.wait(check, timeout=120)
        self.assertEqual(task["State"], "Finished")
        self.assertIn("No Errors", " ".join(task.get("Console") or []))


def iris_container():
    """Id of the running IRIS container (IRIS_CONTAINER overrides), or None when docker is not available."""
    if os.environ.get("IRIS_CONTAINER"):
        return os.environ["IRIS_CONTAINER"]
    try:
        out = subprocess.run(["docker", "ps", "-q", "--filter", "name=iris-admin-deck"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    return (out.stdout.split() or [None])[0]


def iris_session(container, code):
    """Runs ObjectScript lines in the USER namespace of the container (iris session, OS authentication)."""
    out = subprocess.run(["docker", "exec", "-i", container, "iris", "session", "IRIS", "-U", "USER"],
                         input=code + "\nhalt\n", capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr or out.stdout
    return out.stdout


class JournalExplorer(unittest.TestCase):
    """The journal explorer's calls find a global change made in USER: records (filtered, newest first) and its details."""

    @classmethod
    def setUpClass(cls):
        cls.container = iris_container()
        if not cls.container:
            raise unittest.SkipTest("no local IRIS container to make a journaled change in")
        cls.api = Client("/api/admin")
        cls.node = f"^ZJRNTEST({os.getpid()})"
        cls.new = f"new-{PREFIX}"
        # Old values are journaled only inside a transaction: the second SET runs in one.
        iris_session(cls.container, f'set {cls.node}="old" tstart  set {cls.node}="{cls.new}" tcommit')

    @classmethod
    def tearDownClass(cls):
        iris_session(cls.container, f"kill {cls.node}")

    def records(self, file, **query):
        r = self.api.ok("POST", "/v2/journal/file/records", {"file": file, "reverse": 1, "maxRows": 50, **query}, {})
        self.assertEqual(r.status, 202)
        task = self.api.wait(r)
        self.assertEqual(task["State"], "Finished", task.get("FailureReason"))
        return task["Result"]

    def test_find_change_and_details(self):
        files = sorted(self.api.get("/v2/journal/files"), key=lambda f: (f["CreationTime"], f["Name"]), reverse=True)
        current = files[0]["Name"]
        rows = self.records(current, matchColumnName="GlobalNode", matchOperator="[", matchValue=self.node)
        self.assertTrue(rows, f"no journal records for {self.node}")
        self.assertTrue(all(self.node in r["GlobalNode"] for r in rows))
        self.assertEqual([r["Address"] for r in rows], sorted((r["Address"] for r in rows), reverse=True))  # newest first
        latest = rows[0]
        self.assertEqual((latest["TypeName"], latest["InTransaction"]), ("SET", True))

        record = self.api.get("/v2/journal/file/record", file=current, address=latest["Address"])
        self.assertEqual(record["SetKill"]["NewValue"], self.new)
        self.assertEqual(record["SetKill"]["OldValue"], "old")
        self.assertEqual(str(record["ProcessID"]), str(latest["ProcessID"]))

        by_pid = self.records(current, matchColumnName="ProcessID", matchOperator="=", matchValue=latest["ProcessID"])
        self.assertIn(latest["Address"], [r["Address"] for r in by_pid])
        self.assertTrue(all(str(r["ProcessID"]) == str(latest["ProcessID"]) for r in by_pid))

    def test_paging_continues_from_initial_offset(self):
        current = sorted(self.api.get("/v2/journal/files"), key=lambda f: (f["CreationTime"], f["Name"]), reverse=True)[0]["Name"]
        # IRIS 2026.2 returns half of maxRows (rounded up); the UI asks for twice its page size.
        first_page = self.records(current, maxRows=10)
        if len(first_page) < 5:
            self.skipTest("journal file too small to page")
        last = first_page[-1]["Address"]
        second = self.records(current, maxRows=10, initialOffset=last)
        self.assertEqual(second[0]["Address"], last)  # initialOffset is inclusive
        self.assertTrue(all(r["Address"] <= last for r in second))


class WriteFlows(unittest.TestCase):
    """The create / edit / delete flows the UI performs, each verified by reading the object back."""

    @classmethod
    def setUpClass(cls):
        cls.api = Client("/api/admin")

    def setUp(self):
        self.created = []  # (path, query) of objects to delete, most recent first

    def track(self, path, **query):
        self.created.insert(0, (path, query))

    def tearDown(self):
        # Removes exactly what this test created (secrets before their collection, users before roles).
        for path, query in self.created:
            r = self.api.call("DELETE", path, query)
            if r.status not in (200, 404) and not any(e.get("id", "").endswith("DoesNotExist") for e in r.errors):
                print(f"cleanup failed: DELETE {path} {query} -> {r.status} {r.errors}")

    def test_web_application(self):
        name = f"/{PREFIX.lower()}-app"
        self.track("/v2/web-app", name=name)
        # IRIS 2026.2 quirk: on create ServeFiles/UseCookies must be numeric codes (see README notes).
        self.api.ok("PUT", "/v2/web-app", {"name": name}, {"NameSpace": "USER", "DispatchClass": "AdminDeck.REST.Dispatch", "AutheEnabled": 32, "ServeFiles": 0})
        self.assertEqual(self.api.get("/v2/web-app", name=name)["DispatchClass"], "AdminDeck.REST.Dispatch")
        # IRIS 2026.2 quirk: the spec's "Never" is rejected; the real value is "No".
        self.assertEqual(self.api.get("/v2/web-app", name=name)["ServeFiles"], "No")
        self.assertTrue(self.api.call("PUT", "/v2/web-app", {"name": name}, {"ServeFiles": "Never"}).errors)
        self.api.ok("PUT", "/v2/web-app", {"name": name}, {"ServeFiles": "No", "Description": "edited", "Enabled": False})
        app = self.api.get("/v2/web-app", name=name)
        self.assertEqual((app["Description"], app["Enabled"]), ("edited", False))
        self.api.ok("DELETE", "/v2/web-app", {"name": name})
        self.assertEqual(self.api.call("GET", "/v2/web-app", {"name": name}).errors[0]["id"], "ApplicationDoesNotExist")

    def test_user_role_resource(self):
        resource, role, user = f"{PREFIX}Res", f"{PREFIX}Role", f"{PREFIX}User"
        self.track("/v2/security/resource", name=resource)
        self.track("/v2/security/role", name=role)
        self.track("/v2/security/user", name=user)
        # IRIS 2026.2: an empty PublicPermission is rejected (400 without a message) — documented quirk.
        self.assertEqual(self.api.call("PUT", "/v2/security/resource", {"name": resource}, {"Description": "t", "PublicPermission": ""}).status, 400)
        self.api.ok("PUT", "/v2/security/resource", {"name": resource}, {"Description": "t", "PublicPermission": "R"})
        self.api.ok("PUT", "/v2/security/role", {"name": role}, {"Description": "t", "Resources": [{"Name": resource, "Permissions": "RW"}]})
        self.assertEqual(self.api.get("/v2/security/role", name=role)["Resources"][0]["Name"], resource)
        self.api.ok("POST", "/v2/security/user", {"name": user}, {"User": {"FullName": "t", "Roles": [role], "Enabled": True, "ChangePassword": False}, "Password": "zzT3st!pass"})
        self.assertEqual(self.api.get("/v2/security/user", name=user)["Roles"], [role])
        owners = self.api.get("/v2/security/role/owners", name=role)
        self.assertIn(user, json.dumps(owners))
        self.api.ok("POST", "/v2/security/user/password", {"name": user}, {"NewPassword": "zzT3st!pass2"})
        self.assertTrue(Client("/api/admin", user, "zzT3st!pass2").token, "new password works for JWT login")
        self.api.ok("PUT", "/v2/security/user", {"name": user}, {"Enabled": False})
        self.assertFalse(self.api.get("/v2/security/user", name=user)["Enabled"])
        for path, name in [("/v2/security/user", user), ("/v2/security/role", role), ("/v2/security/resource", resource)]:
            self.api.ok("DELETE", path, {"name": name})
            self.assertTrue(self.api.call("GET", path, {"name": name}).errors, f"{name} still exists")

    def test_wallet(self):
        collection = f"{PREFIX}Wallet"
        self.track("/v2/wallet/collection", name=collection)
        self.track("/v2/wallet/secret", name=f"{collection}.key")
        self.api.ok("PUT", "/v2/wallet/collection", {"name": collection}, {"EditResource": "%Admin_Wallet:USE", "UseResource": "%Admin_Wallet:USE"})
        self.api.ok("PUT", "/v2/wallet/secret", {"name": f"{collection}.key"}, {"Type": "%Wallet.KeyValue", "WalletSecretConfig": {"Secret": {"user": "u", "password": "p"}}})
        secrets = self.api.get("/v2/wallet/secrets", collection=collection)
        self.assertEqual([s["Name"] for s in secrets], [f"{collection}.key"])
        self.assertNotIn("Secret", json.dumps(secrets))  # values are never returned
        self.api.ok("DELETE", "/v2/wallet/secret", {"name": f"{collection}.key"})
        self.api.ok("DELETE", "/v2/wallet/collection", {"name": collection})
        self.assertFalse([c for c in self.api.get("/v2/wallet/collections") if c["Name"] == collection])

    def test_task_lifecycle(self):
        name = f"{PREFIX} task"
        tomorrow = time.strftime("%Y-%m-%d", time.gmtime(time.time() + 86400))
        body = {"Name": name, "NameSpace": "USER", "TaskClass": "AdminDeck.Task.ReindexLogs", "RunAsUser": "_SYSTEM",
                "TimePeriod": "Daily", "TimePeriodEvery": 1, "DailyFrequency": "Once", "DailyStartTime": "02:00:00",
                "Priority": "Normal", "SuspendOnError": False, "RescheduleOnStart": True, "Description": "t", "Settings": {},
                "EmailOnCompletion": [], "EmailOnError": [], "EmailOnExpiration": [], "EmailOutput": False, "Expires": False,
                "ExpiresDays": "", "ExpiresHours": "", "ExpiresMinutes": "", "OutputDirectory": "", "OutputFilename": "",
                "OpenOutputFile": False, "OutputFileIsBinary": False, "TimePeriodDay": "", "DailyFrequencyTime": "",
                "DailyIncrement": "", "DailyEndTime": "", "StartDate": tomorrow, "EndDate": "", "RunAfterGUID": "",
                "MirrorStatus": "Any", "IsBatch": False, "SuspendTerminated": False}
        self.api.ok("POST", "/v2/task", body=body)
        task_id = next(t["Id"] for t in self.api.get("/v2/tasks", filter=PREFIX) if t["Name"] == name)
        self.track("/v2/task", id=task_id)
        self.api.ok("POST", "/v2/task/suspend", {"id": task_id}, {"LeaveInQueue": True})
        self.assertTrue(self.api.get("/v2/task/info", id=task_id)["Suspended"])
        self.api.ok("POST", "/v2/task/resume", {"id": task_id}, {})
        self.assertFalse(self.api.get("/v2/task/info", id=task_id)["Suspended"])
        self.api.ok("PUT", "/v2/task", {"id": task_id}, {"Description": "edited"})
        self.assertEqual(self.api.get("/v2/task", id=task_id)["Description"], "edited")
        self.api.ok("POST", "/v2/task/run", {"id": task_id}, {"RunNow": True})
        deadline = time.time() + 60  # the run is queued: wait until it appears in the task history
        while not self.api.get("/v2/task/history", taskId=task_id) and time.time() < deadline:
            time.sleep(1)
        self.assertTrue(self.api.get("/v2/task/history", taskId=task_id), "run-now did not execute")
        self.api.ok("DELETE", "/v2/task", {"id": task_id})
        self.assertTrue(self.api.call("GET", "/v2/task", {"id": task_id}).errors)

    def test_tls_configuration(self):
        name = f"{PREFIX}TLS"
        self.track("/v2/security/ssl-configuration", name=name)
        self.api.ok("PUT", "/v2/security/ssl-configuration", {"name": name}, {"Type": 0, "Enabled": True, "VerifyPeer": 0, "TLSMinVersion": 16, "TLSMaxVersion": 32})
        cfg = self.api.get("/v2/security/ssl-configuration", name=name)
        self.assertEqual((cfg["Type"], cfg["TLSMinVersion"]), (0, 16))
        self.api.ok("DELETE", "/v2/security/ssl-configuration", {"name": name})

    def test_database_namespace_mapping(self):
        db, ns = PREFIX.upper() + "DB", PREFIX.upper() + "NS"
        mgr = next(d["Directory"] for d in self.api.get("/v2/databases") if d["Name"] == "IRISSYS")
        directory = f"{mgr}{db.lower()}/"
        # Cleanup runs in reverse: mapping, namespace, database definition, database file.
        self.track("/v2/database-dir", dir=directory)
        self.track("/v2/database", name=db)
        self.track("/v2/namespace", name=ns)
        self.track("/v2/namespace/global-mapping", namespace=ns, name="ZzMapped")
        # A database is a file (POST /v2/database-dir) plus a named definition (PUT /v2/database).
        # IRIS 2026.2: without GlobalJournalState the new database is not journaled.
        created = self.api.ok("POST", "/v2/database-dir", body={"Directory": directory, "Size": 1, "GlobalJournalState": True, "ResourceName": "%DB_%DEFAULT"})
        self.assertEqual(created.status, 201)
        self.api.ok("PUT", "/v2/database", {"name": db}, {"Directory": directory})
        self.assertEqual(self.api.get("/v2/database", name=db)["Directory"], directory)
        self.api.ok("PUT", "/v2/database-dir", {"dir": directory}, {"MaxSize": 20, "ExpansionSize": 1})
        self.api.ok("PUT", "/v2/database", {"name": db}, {"MountRequired": True})
        settings = self.api.get("/v2/database-dir", dir=directory)
        self.assertEqual((settings["MaxSize"], settings["ExpansionSize"], settings["GlobalJournalState"]), (20, 1, True))
        self.assertTrue(self.api.get("/v2/database", name=db)["MountRequired"])
        # Namespace: Routines is required on create even though the spec marks nothing as required.
        self.assertEqual(self.api.call("PUT", "/v2/namespace", {"name": ns}, {"Globals": db}).status, 400)
        self.api.ok("PUT", "/v2/namespace", {"name": ns}, {"Globals": db, "Routines": db})
        self.api.ok("PUT", "/v2/namespace", {"name": ns}, {"Routines": "USER"})
        self.assertEqual(self.api.get("/v2/namespace", name=ns), {"Globals": db, "Routines": "USER", "TempGlobals": "IRISTEMP"})
        self.api.ok("PUT", "/v2/namespace/global-mapping", {"namespace": ns, "name": "ZzMapped"}, {"Database": "USER"})
        self.assertEqual(self.api.get("/v2/namespace/global-mapping", namespace=ns, name="ZzMapped")["Database"], "USER")
        self.assertIn("ZzMapped", [m["Name"] for m in self.api.get("/v2/namespace/global-mappings", namespace=ns)])
        # The definition cannot be deleted while a namespace uses the database (409 CPFDatabaseInUse).
        self.assertEqual(self.api.call("DELETE", "/v2/database", {"name": db}).status, 409)
        self.api.ok("DELETE", "/v2/namespace/global-mapping", {"namespace": ns, "name": "ZzMapped"})
        self.assertEqual(self.api.call("GET", "/v2/namespace/global-mapping", {"namespace": ns, "name": "ZzMapped"}).status, 404)
        self.api.ok("DELETE", "/v2/namespace", {"name": ns})
        self.assertEqual(self.api.call("GET", "/v2/namespace", {"name": ns}).status, 404)
        self.api.ok("DELETE", "/v2/database", {"name": db})
        self.api.ok("DELETE", "/v2/database-dir", {"dir": directory})
        self.assertEqual(self.api.call("GET", "/v2/database", {"name": db}).status, 404)
        self.assertEqual(self.api.call("GET", "/v2/database-dir", {"dir": directory}).status, 404)


class ExtensionApi(unittest.TestCase):
    """/admindeck/api: logs (current + rotated), insights, vector search, OS metrics, application errors."""

    @classmethod
    def setUpClass(cls):
        cls.ext = Client("/admindeck/api")
        assert cls.ext.token, "JWT login to /admindeck/api failed"

    def test_whoami_and_os(self):
        me = self.ext.get("/whoami")
        self.assertEqual(me["canOperate"], 1)
        self.assertRegex(me["serverTime"], r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$")
        os_ = self.ext.get("/os")
        self.assertGreater(os_["cpu"]["cores"], 0)
        self.assertGreater(os_["memory"]["total"], 0)
        self.assertTrue(os_["disks"])

    def test_logs(self):
        files = self.ext.get("/logs/files")
        keys = {f["key"] for f in files}
        self.assertIn("messages", keys)
        self.assertTrue(any(f["rotated"] for f in files), "demo build has a rotated messages.old_* file")
        page = self.ext.get("/logs/messages", limit=5, severity=0)
        self.assertLessEqual(len(page["entries"]), 5)
        self.assertEqual(set(page["counts"]), {"info", "warning", "severe", "fatal"})
        rotated = next(f["key"] for f in files if f["rotated"])
        self.assertGreater(self.ext.get(f"/logs/{rotated}", limit=1)["total"], 0)
        self.assertIn("patterns", self.ext.get("/logs/messages/insights", severity=0))

    def test_vector_search(self):
        indexed = self.ext.ok("POST", "/logs/messages/index").result["indexed"]
        self.assertGreater(indexed, 0)
        self.assertGreater(self.ext.get("/search/status")["messages"]["count"], 0)
        hits = self.ext.get("/search/similar", q="database mounted read write", k=3)
        self.assertEqual(len(hits), 3)
        scores = [float(h["score"]) for h in hits]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_application_errors(self):
        errors = self.ext.get("/apperrors", days=365, limit=50)
        self.assertIsInstance(errors, list)
        for e in errors:
            self.assertTrue({"namespace", "ts", "number", "message"} <= set(e))

    def test_backups(self):
        b = self.ext.get("/backups", limit=10)
        self.assertTrue({"definitions", "scheduled", "history", "lastSuccessful", "lastFull"} <= set(b))
        self.assertIn("FullAllDatabases", [d["name"] for d in b["definitions"]])
        self.assertLessEqual(len(b["history"]), 10)
        for row in b["history"]:
            self.assertTrue({"type", "time", "status", "ok"} <= set(row))
        for task in b["scheduled"]:
            self.assertTrue(task["taskClass"].startswith("%SYS.Task.Backup"))
        for kind, row in b["lastSuccessful"].items():
            self.assertTrue(row["ok"] and row["type"] == kind)
        self.assertIsInstance(b["lastFull"]["recorded"], bool)

    def test_interop_overview(self):
        o = self.ext.get("/interop")
        self.assertIsInstance(o["canRun"], bool)
        names = {n["namespace"]: n for n in o["namespaces"]}
        self.assertFalse(names["%SYS"]["enabled"])
        for n in o["namespaces"]:
            self.assertIsInstance(n["enabled"], bool)
            if n["enabled"] and "error" not in n:
                self.assertIn(n["state"], ["Running", "Stopped", "Suspended", "Troubled", "NetworkStopped", "Unknown"])
                self.assertIsInstance(n["needsUpdate"], bool)
                detail = self.ext.get(f"/interop/{n['namespace']}")
                self.assertTrue({"items", "queues", "recentErrors", "productions", "canRun"} <= set(detail))

    def test_interop_bad_input(self):
        self.assertEqual(self.ext.call("GET", "/interop/ZZNOSUCHNAMESPACE").status, 404)
        self.assertEqual(self.ext.call("POST", "/interop/%25SYS/start", body={"production": "X.Y"}).status, 404)
        enabled = [n["namespace"] for n in self.ext.get("/interop")["namespaces"] if n["enabled"]]
        if not enabled:
            self.skipTest("no namespace with Interoperability")
        ns = enabled[0]
        self.assertEqual(self.ext.call("POST", f"/interop/{ns}/delete", body={}).status, 400)
        self.assertEqual(self.ext.call("POST", f"/interop/{ns}/start", body={}).status, 400)
        self.assertEqual(self.ext.call("POST", f"/interop/{ns}/start", body={"production": "x;kill ^y"}).status, 400)
        self.assertEqual(self.ext.call("POST", f"/interop/{ns}/start", body={"production": "AdminDeck.zzNoSuchProduction"}).status, 404)
        # Stop / update / recover name the production the caller expects; any other one is a conflict, never acted on.
        for action in ["stop", "update", "recover"]:
            with self.subTest(action=action):
                self.assertEqual(self.ext.call("POST", f"/interop/{ns}/{action}", body={"production": "x;kill ^y"}).status, 400)
                r = self.ext.call("POST", f"/interop/{ns}/{action}", body={"production": "AdminDeck.zzNoSuchProduction"})
                self.assertEqual(r.status, 409)
                self.assertIn("AdminDeck.zzNoSuchProduction", r.errors[0]["error"])
        self.assertEqual(self.ext.call("POST", f"/interop/{ns}/stop", body={}).status, 400)

    def test_change_log(self):
        what = f"Web application /{PREFIX.lower()} saved"
        r = self.ext.ok("POST", "/changes", body={
            "what": what, "outcome": "not-reflected", "details": "Description", "user": "someone-else",
            "calls": [{"method": "PUT", "path": f"/api/admin/v2/web-app?name=%2F{PREFIX.lower()}&token=abc", "body": {"Password": "x"}}]})
        entry = r.result
        self.assertEqual(entry["user"], USER, "the username comes from the session, not the body")
        self.assertEqual(entry["calls"], [{"method": "PUT", "path": f"/api/admin/v2/web-app?name=%2F{PREFIX.lower()}&token=***"}])
        rows = self.ext.get("/changes", q=PREFIX, limit=5)
        self.assertEqual(rows[0]["id"], entry["id"], "newest first")
        self.assertEqual((rows[0]["what"], rows[0]["outcome"], rows[0]["details"]), (what, "not-reflected", "Description"))
        self.assertNotIn("Password", json.dumps(rows))
        self.assertTrue(all(row["user"] == USER for row in self.ext.get("/changes", user=USER, limit=20)))
        self.assertEqual(self.ext.call("POST", "/changes", body={"what": "x", "outcome": "done"}).status, 400)
        self.assertEqual(self.ext.call("POST", "/changes", body={"outcome": "verified"}).status, 400)

    def test_bad_input(self):
        self.assertEqual(self.ext.call("GET", "/logs/iris.cpf").status, 404)
        self.assertEqual(self.ext.call("GET", "/logs/messages.old_..").status, 404)
        self.assertEqual(self.ext.call("GET", "/search/similar").status, 400)


class Security(unittest.TestCase):
    def test_unauthenticated_requests_are_refused(self):
        self.assertEqual(raw("GET", "/admindeck/api/os").status, 401)
        self.assertEqual(raw("GET", "/api/admin/v2/tasks", headers={"Authorization": "Bearer invalid"}).status, 401)
        self.assertEqual(raw("POST", "/api/admin/login", body={"user": USER, "password": "wrong"}).status, 401)

    def test_refresh_token_rotates(self):
        c = Client("/api/admin")
        r = raw("POST", "/api/admin/refresh", body={"refresh_token": c.refresh_token})
        self.assertEqual(r.status, 200)
        self.assertTrue(r.json["access_token"])
        again = raw("POST", "/api/admin/refresh", body={"refresh_token": c.refresh_token})
        self.assertEqual(again.status, 401, "a used refresh token must be rejected")

    def test_no_cors_on_admin_api(self):
        r = raw("GET", "/api/admin/info", headers={"Origin": "https://evil.example"})
        self.assertIsNone(r.headers.get("Access-Control-Allow-Origin"))

    def test_extension_requires_operate_privilege(self):
        # An authenticated developer without %Admin_Operate can sign in but gets 403 from every endpoint.
        api = Client("/api/admin")
        name = f"{PREFIX}Dev"
        api.ok("POST", "/v2/security/user", {"name": name}, {"User": {"Roles": ["%Developer"], "Enabled": True, "ChangePassword": False}, "Password": "zzT3st!pass"})
        try:
            dev = Client("/admindeck/api", name, "zzT3st!pass")
            self.assertTrue(dev.token, "developer can sign in")
            for path in ["/os", "/logs/files", "/logs/messages", "/apperrors", "/search/status", "/backups", "/interop", "/interop/USER"]:
                with self.subTest(path=path):
                    self.assertEqual(dev.call("GET", path).status, 403)
            self.assertEqual(dev.call("POST", "/interop/USER/stop", body={}).status, 403)
            # The change log: anyone signed in records their own changes, only admins read the log.
            recorded = dev.ok("POST", "/changes", body={"what": f"{PREFIX} developer change", "outcome": "failed", "details": "HTTP 403"}).result
            self.assertEqual(recorded["user"], name)
            self.assertEqual(dev.call("GET", "/changes").status, 403)
            self.assertIn(recorded["id"], [row["id"] for row in Client("/admindeck/api").get("/changes", user=name)])
        finally:
            api.call("DELETE", "/v2/security/user", {"name": name})

    def test_production_actions_require_ens_production_run(self):
        # %Operator may read production status (%Admin_Operate) but not start or stop one (%Ens_ProductionRun).
        api = Client("/api/admin")
        name = f"{PREFIX}Op"
        api.ok("POST", "/v2/security/user", {"name": name}, {"User": {"Roles": ["%Operator"], "Enabled": True, "ChangePassword": False}, "Password": "zzT3st!pass"})
        try:
            op = Client("/admindeck/api", name, "zzT3st!pass")
            overview = op.ok("GET", "/interop").result
            self.assertFalse(overview["canRun"])
            for action in ["start", "stop", "update", "recover"]:
                with self.subTest(action=action):
                    r = op.call("POST", f"/interop/USER/{action}", body={"production": "AdminDeck.zzNoSuchProduction"})
                    self.assertEqual(r.status, 403)
                    self.assertIn("%Ens_ProductionRun", r.errors[0]["error"])
        finally:
            api.call("DELETE", "/v2/security/user", {"name": name})

    def test_ui_is_served_same_origin(self):
        for path in ["/admindeck/index.html", "/admindeck/js/app.js", "/admindeck/js/verify.js", "/admindeck/js/palette.js", "/admindeck/openapi.json"]:
            with self.subTest(path=path):
                self.assertEqual(raw("GET", path).status, 200)


if __name__ == "__main__":
    unittest.main(verbosity=2)
