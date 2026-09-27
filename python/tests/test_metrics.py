from admindeck import metrics

SAMPLE = """# HELP iris_csp_activity Web requests served
iris_csp_activity{id="127.0.0.1:52773"} 1369
iris_csp_gateway_latency{id="127.0.0.1:52773"} .16
iris_db_latency{id="IRISSYS"} 0.005
iris_db_latency{id="USER"} 0.012
iris_sql_queries_avg_runtime{id="%SYS"} .002
iris_sql_queries_avg_runtime{id="USER"} .010
iris_sql_queries_per_second{id="%SYS"} 3
iris_sql_queries_per_second{id="USER"} 1
iris_system_state 1
"""


def test_summary():
    web, gateway, db, qps, avg_ms, state = metrics.summary(SAMPLE)
    assert (web, gateway, db, qps, state) == (1369, 0.16, 0.012, 4, 1)
    assert avg_ms == 4.0  # (2 ms * 3/s + 10 ms * 1/s) / 4/s


def test_empty_text():
    assert metrics.summary("") == (None, None, None, None, None, None)
