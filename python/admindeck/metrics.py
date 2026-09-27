"""Summary of the IRIS metrics text (the /api/monitor/metrics exposition format) for the status page."""
import re

LINE = re.compile(r'^(iris_\w+)(?:\{id="([^"]*)"\})? (\S+)$')


def parse(text):
    """{metric: {id: value}} for every sample line (id is "" for metrics without one)."""
    out = {}
    for line in text.splitlines():
        m = LINE.match(line)
        if m:
            try:
                out.setdefault(m[1], {})[m[2] or ""] = float(m[3])
            except ValueError:
                pass
    return out


def summary(text):
    """(web requests since start, gateway latency ms, slowest database read ms, SQL statements/s,
    average SQL runtime ms weighted by each namespace's rate, system state -1 hung / 0 ok / 1 warning / 2 alert).
    A value IRIS does not publish (sensor group excluded, gateway not reachable) is None, not zero."""
    m = parse(text)
    qps = m.get("iris_sql_queries_per_second")
    runtime = m.get("iris_sql_queries_avg_runtime")
    total = sum(qps.values()) if qps else None
    avg_ms = None
    if qps is not None and runtime is not None:
        avg_ms = round(sum(runtime.get(ns, 0) * rate for ns, rate in qps.items()) * 1000 / total, 3) if total else 0
    pick = lambda name, f: round(f(m[name].values()), 3) if m.get(name) else None
    state = m.get("iris_system_state", {}).get("")
    return (pick("iris_csp_activity", sum), pick("iris_csp_gateway_latency", max), pick("iris_db_latency", max),
            None if total is None else round(total, 2), avg_ms, None if state is None else int(state))
