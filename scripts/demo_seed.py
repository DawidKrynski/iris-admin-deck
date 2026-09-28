#!/usr/bin/env python3
"""Seeds demo data through the SysAdmin API itself, so every screen has something to show.

Creates: two X.509 credentials (one expiring soon), a wallet collection with dummy secrets, a
limited "demo_operator" user (only operator privileges, to show privilege-aware navigation) and a small
incident to follow: database REPORTS left dismounted and a "Sales export" task, every 5 minutes, that fails
while it is.
Idempotent: existing objects are left alone.

Usage: python3 scripts/demo_seed.py [base_url]    (env IRIS_USER / IRIS_PASSWORD, default SuperUser/SYS)
       python3 scripts/demo_seed.py --incident [base_url]
           dismounts REPORTS again; docker-compose.yml runs it after every start of the container, because
           IRIS would mount the database on the first reference after a restart.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ARGS = [a for a in sys.argv[1:] if not a.startswith("--")]
BASE = (ARGS[0] if ARGS else "http://localhost:52773").rstrip("/") + "/api/admin/v2"
REPORTS_DIR = "/usr/irissys/mgr/reports/"
AUTH = base64.b64encode(f"{os.environ.get('IRIS_USER', 'SuperUser')}:{os.environ.get('IRIS_PASSWORD', 'SYS')}".encode()).decode()
CERT_DIR = os.environ.get("DEMO_CERT_DIR", "/usr/irissys/mgr/demo-certs")


def call(method, path, query=None, body=None):
    url = f"{BASE}{path}" + (f"?{urllib.parse.urlencode(query)}" if query else "")
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": f"Basic {AUTH}", "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req) as res:
            return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def exists(path, query):
    status, _ = call("GET", path, query)
    return status == 200


def step(label, status, payload):
    errors = (payload.get("status") or {}).get("errors") or []
    print(f"  {'ok ' if status < 300 and not errors else 'ERR'} {label}" + (f": {errors[0].get('error')}" if errors else ""))


def make_cert(alias, days):
    os.makedirs(CERT_DIR, exist_ok=True)
    key, crt = f"{CERT_DIR}/{alias}.key", f"{CERT_DIR}/{alias}.crt"
    if not os.path.exists(crt):
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt,
                        "-days", str(days), "-subj", f"/CN={alias}.demo.local/O=IRIS Admin Deck demo"],
                       check=True, capture_output=True)
    return key, crt


def main():
    print(f"Seeding demo data via {BASE}")
    for alias, days in (("demo-api-client", 365), ("demo-legacy-partner", 12)):
        if exists("/security/x509-credential", {"alias": alias}):
            continue
        key, crt = make_cert(alias, days)
        step(f"X.509 credential {alias} ({days} days)", *call("POST", "/security/x509-credential", {"alias": alias},
             {"Alias": alias, "CertificateFile": crt, "PrivateKeyFile": key, "OwnerList": []}))

    if not exists("/wallet/collection", {"name": "demo-integrations"}):
        step("wallet collection demo-integrations", *call("PUT", "/wallet/collection", {"name": "demo-integrations"},
             {"EditResource": "%Admin_Wallet:USE", "UseResource": "%Admin_Wallet:USE"}))
        for name, secret in (("crm-api", {"user": "demo", "password": "not-a-real-secret"}),
                             ("payments-webhook", {"token": "not-a-real-token"})):
            step(f"wallet secret demo-integrations.{name}", *call("PUT", "/wallet/secret", {"name": f"demo-integrations.{name}"},
                 {"Type": "%Wallet.KeyValue", "WalletSecretConfig": {"Secret": secret}}))

    if not exists("/security/user", {"name": "demo_operator"}):
        step("user demo_operator", *call("POST", "/security/user", {"name": "demo_operator"}, {
            "User": {"FullName": "Demo operator (limited privileges)", "Enabled": True, "ChangePassword": False,
                     "PasswordNeverExpires": True, "Roles": ["%Operator"]},
            "Password": os.environ.get("DEMO_OPERATOR_PASSWORD", "operator")}))
    seed_incident()
    print("Done.")


def seed_incident():
    """Database REPORTS and a "Sales export" task that reads it every 5 minutes. The incident itself, REPORTS
    dismounted, is made by dismount_reports() when the container starts: the dashboard then lists the
    database, the timeline the failed export runs, and Mount / Run again fix it."""
    directory = REPORTS_DIR
    if exists("/database", {"name": "REPORTS"}):
        return
    step("database REPORTS", *call("POST", "/database-dir", body={"Directory": directory, "Size": 1,
         "GlobalJournalState": True, "ResourceName": "%DB_%DEFAULT"}))
    step("database definition REPORTS", *call("PUT", "/database", {"name": "REPORTS"}, {"Directory": directory}))
    task = "Sales export"
    step(f"task {task}", *call("POST", "/task", body={
        "Name": task, "NameSpace": "USER", "TaskClass": "%SYS.Task.RunLegacyTask", "RunAsUser": "_SYSTEM",
        "Settings": {"ExecuteCode": 'set total=0,r="" for { set r=$order(^|"^^' + directory + '"|Daily(r)) quit:r=""  set total=total+1 }'},
        "Description": "Totals today's sales from REPORTS for the reporting team",
        "TimePeriod": "Daily", "TimePeriodEvery": 1, "DailyFrequency": "Several", "DailyFrequencyTime": "Minutes",
        "DailyIncrement": 5, "DailyStartTime": "00:00:00", "DailyEndTime": "23:59:00",
        "Priority": "Normal", "SuspendOnError": False, "RescheduleOnStart": True,
        "EmailOnCompletion": [], "EmailOnError": [], "EmailOnExpiration": [], "EmailOutput": False, "Expires": False,
        "ExpiresDays": "", "ExpiresHours": "", "ExpiresMinutes": "", "OutputDirectory": "", "OutputFilename": "",
        "OpenOutputFile": False, "OutputFileIsBinary": False, "TimePeriodDay": "", "StartDate": time.strftime("%Y-%m-%d"), "EndDate": "",
        "RunAfterGUID": "", "MirrorStatus": "Any", "IsBatch": False, "SuspendTerminated": False}))


def dismount_reports():
    if not exists("/database", {"name": "REPORTS"}):
        return  # built without the demo data
    # Mount first: after a restart the database is not mounted, and only an explicit dismount keeps IRIS
    # from mounting it again on the next reference.
    call("POST", "/database-dir/mount", {"dir": REPORTS_DIR}, {})
    step("dismount REPORTS", *call("POST", "/database-dir/dismount", {"dir": REPORTS_DIR}, {}))
    # Index messages.log again, so Similar incidents already knows this dismount and the earlier ones.
    ext = BASE.replace("/api/admin/v2", "/admindeck/api")
    req = urllib.request.Request(f"{ext}/logs/messages/index", data=b"{}", method="POST", headers={
        "Authorization": f"Basic {AUTH}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as res:
            print(f"  ok  messages.log indexed: {json.loads(res.read())['result']['indexed']} entries")
    except (urllib.error.URLError, KeyError, ValueError) as e:
        print(f"  ERR messages.log index: {e}")


if __name__ == "__main__":
    dismount_reports() if "--incident" in sys.argv else main()
