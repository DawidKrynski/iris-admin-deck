#!/usr/bin/env python3
"""Print a resolved view of SysAdmin API endpoints from web/openapi.json.

Usage: scripts/endpoint.py <path-substring> [--schemas]
Example: scripts/endpoint.py /v2/task/run
"""
import json
import os
import sys

SPEC = json.load(open(os.path.join(os.path.dirname(__file__), "..", "web", "openapi.json")))
COMP = SPEC["components"]


def resolve(node, depth=0):
    if depth > 6:
        return node
    if isinstance(node, dict):
        if "$ref" in node:
            kind, name = node["$ref"].split("/")[-2:]
            return resolve(COMP[kind][name], depth + 1)
        return {k: resolve(v, depth + 1) for k, v in node.items()}
    if isinstance(node, list):
        return [resolve(x, depth + 1) for x in node]
    return node


def show(path, item, schemas):
    common = [resolve(p) for p in item.get("parameters", [])]
    for method, op in item.items():
        if method == "parameters":
            continue
        params = common + [resolve(p) for p in op.get("parameters", [])]
        print(f"\n{method.upper()} /api/admin{path}\n  {op.get('summary', '')}")
        for p in params:
            print(f"  ?{p.get('name')} ({'required' if p.get('required') else 'optional'}) {p.get('description', '')[:100]}")
        body = op.get("requestBody")
        if body:
            schema = resolve(body["content"]["application/json"]["schema"])
            print("  body:", json.dumps(schema, indent=1)[:3000 if schemas else 1200])
        if schemas:
            ok = op.get("responses", {}).get("200")
            if ok:
                print("  200:", json.dumps(resolve(ok), indent=1)[:3000])


if __name__ == "__main__":
    needle = sys.argv[1] if len(sys.argv) > 1 else ""
    schemas = "--schemas" in sys.argv
    for path, item in SPEC["paths"].items():
        if needle in path:
            show(path, item, schemas)
