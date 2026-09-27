#!/usr/bin/env python3
"""Seeds demo data through the SysAdmin API itself, so every screen has something to show.

Creates: two X.509 credentials (one expiring soon), a wallet collection with dummy secrets and a
limited "demo_operator" user (only operator privileges, to show privilege-aware navigation).
Idempotent: existing objects are left alone.

Usage: python3 scripts/demo_seed.py [base_url]    (env IRIS_USER / IRIS_PASSWORD, default SuperUser/SYS)
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:52773").rstrip("/") + "/api/admin/v2"
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
    print("Done.")


if __name__ == "__main__":
    main()
