#!/usr/bin/env bash
# Smoke test of a running instance: UI, SysAdmin API (JWT) and the extension API.
set -euo pipefail
B=${1:-http://localhost:52785}
U=${IRIS_USER:-SuperUser}; P=${IRIS_PASSWORD:-SYS}
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1"; pass=$((pass+1)); else echo "  FAIL $1 (got $2, want $3)"; fail=$((fail+1)); fi; }
token() { curl -s -X POST -H 'Content-Type: application/json' -d "{\"user\":\"$U\",\"password\":\"$P\"}" "$B$1/login" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("access_token",""))'; }
check "UI index"            "$(curl -s -o /dev/null -w '%{http_code}' $B/admindeck/index.html)" 200
check "UI module"           "$(curl -s -o /dev/null -w '%{http_code}' $B/admindeck/js/app.js)" 200
A=$(token /api/admin); E=$(token /admindeck/api)
check "SysAdmin JWT login"  "$([ -n "$A" ] && echo yes)" yes
check "extension JWT login" "$([ -n "$E" ] && echo yes)" yes
check "GET /v2/tasks"       "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $A" $B/api/admin/v2/tasks)" 200
check "extension /os"       "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $E" $B/admindeck/api/os)" 200
check "extension log files" "$(curl -s -H "Authorization: Bearer $E" $B/admindeck/api/logs/files | python3 -c 'import json,sys;print(any(f["rotated"] for f in json.load(sys.stdin)["result"]))')" True
check "reindex messages"    "$(curl -s -X POST -H "Authorization: Bearer $E" $B/admindeck/api/logs/messages/index | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"]["indexed"]>0)')" True
check "similar search"      "$(curl -s -H "Authorization: Bearer $E" "$B/admindeck/api/search/similar?q=journal&k=3" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["result"]))')" 3
check "unauthenticated ext" "$(curl -s -o /dev/null -w '%{http_code}' $B/admindeck/api/os)" 401
check "path traversal"      "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $E" "$B/admindeck/api/logs/iris.cpf")" 404
echo "$pass passed, $fail failed"; [ $fail -eq 0 ]
