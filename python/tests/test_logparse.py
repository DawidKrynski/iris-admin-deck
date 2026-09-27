from admindeck import embed, logparse

SAMPLE = """09/25/26-21:48:03:123 (1234) 0 [Utility.Event] Journaling to /usr/irissys/mgr/journal/20260925.001 started
09/25/26-21:48:04:001 (1235) 2 [Generic.Event] Error opening file /tmp/a.txt: 13
  continuation line
09/25/26-21:49:04:001 (1299) 2 [Generic.Event] Error opening file /tmp/b.txt: 2
09/25/26-21:50:00:000 (77) 1 [SYSTEM MONITOR] CPUusage Warning: CPUusage = 91 ( Warnvalue is 85)."""


def test_parse_and_continuation():
    entries = logparse.parse_lines(SAMPLE.splitlines())
    assert len(entries) == 4
    assert entries[0]["ts"] == "2026-09-25 21:48:03"
    assert entries[1]["severity"] == 2 and "continuation line" in entries[1]["message"]
    assert entries[3]["source"] == "SYSTEM MONITOR"


def test_insights_groups_patterns(tmp_path):
    p = tmp_path / "messages.log"
    p.write_text(SAMPLE)
    res = logparse.insights(str(p))
    top = res["patterns"][0]
    assert top["count"] == 2 and top["maxSeverity"] == 2


def test_query_filters_newest_first(tmp_path):
    p = tmp_path / "messages.log"
    p.write_text(SAMPLE)
    res = logparse.query(str(p), min_severity=2)
    assert res["total"] == 2 and res["entries"][0]["pid"] == 1299


def test_embedding_similarity():
    a, b, c = (embed.embed(t) for t in (
        "Error opening file /tmp/a.txt: 13", "Error opening file /var/x.log: 2", "CPUusage Warning: CPUusage = 91"))
    cos = lambda x, y: sum(i * j for i, j in zip(x, y))
    assert len(a) == embed.DIM
    assert cos(a, b) > 0.95 > cos(a, c)


def test_line_numbers_of_a_large_log_stay_those_of_the_file(tmp_path, monkeypatch):
    monkeypatch.setattr(logparse, "MAX_BYTES", 1000)
    path = tmp_path / "messages.log"
    path.write_text("".join(f"09/25/26-21:48:{i % 60:02d}:123 (1) 0 [Test] line {i}\n" for i in range(1, 201)))
    entries, _ = logparse.read_file(str(path))
    first = entries[0]
    assert first["message"] == f"line {first['line']}"


def test_missing_log_is_an_error_not_an_empty_log(tmp_path):
    import pytest
    with pytest.raises(FileNotFoundError):
        logparse.read_file(str(tmp_path / "gone.log"))
