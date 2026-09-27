"""Parser for IRIS log files (messages.log / alerts.log / SystemMonitor.log).

Typical line:
    09/25/26-21:48:03:123 (1234) 0 [Utility.Event] Journaling to /usr/irissys/mgr/journal/...
Lines without the prefix are continuations of the previous entry.
"""
import os
import re
from collections import Counter

LINE_RE = re.compile(
    r"^(?P<ts>\d\d/\d\d/\d\d-\d\d:\d\d:\d\d:\d+)\s+\((?P<pid>\d+)\)\s+(?P<sev>\d)\s+\[(?P<src>[^\]]*)\]\s?(?P<msg>.*)$"
)
SEVERITY = {0: "info", 1: "warning", 2: "severe", 3: "fatal"}
MAX_BYTES = 8 * 1024 * 1024  # only the tail of very large logs is parsed

_NUM_RE = re.compile(r"\b(0x[0-9a-f]+|\d+([.:/-]\d+)*)\b", re.I)
_PATH_RE = re.compile(r"(/[\w.@-]+)+/?")
_QUOTED_RE = re.compile(r"'[^']*'|\"[^\"]*\"")


def iso_ts(ts):
    """'09/25/26-21:48:03:123' -> '2026-09-25 21:48:03'."""
    try:
        date, time = ts.split("-", 1)
        mm, dd, yy = date.split("/")
        h, m, s = time.split(":")[:3]
        return f"20{yy}-{mm}-{dd} {h}:{m}:{s}"
    except ValueError:
        return ts


def parse_lines(lines, first=1):
    """Entries from log lines; `first` is the line number of lines[0] in the file."""
    entries = []
    for no, raw in enumerate(lines, first):
        line = raw.rstrip("\r\n")
        if not line.strip():
            continue
        m = LINE_RE.match(line)
        if m:
            entries.append({
                "line": no,
                "ts": iso_ts(m["ts"]),
                "pid": int(m["pid"]),
                "severity": int(m["sev"]),
                "level": SEVERITY.get(int(m["sev"]), "info"),
                "source": m["src"],
                "message": m["msg"],
            })
        elif entries:
            entries[-1]["message"] += "\n" + line
        else:
            entries.append({"line": no, "ts": "", "pid": 0, "severity": 0, "level": "info",
                            "source": "", "message": line})
    return entries


def read_file(path):
    """Returns (entries, size). Reads at most MAX_BYTES from the end of the file; line numbers stay
    those of the whole file. A missing file raises FileNotFoundError (it is not an empty log)."""
    size = os.path.getsize(path)
    first = 1
    with open(path, "rb") as fh:
        if size > MAX_BYTES:
            skipped = 0
            while fh.tell() < size - MAX_BYTES:
                skipped += fh.read(min(1 << 20, size - MAX_BYTES - fh.tell())).count(b"\n")
            fh.readline()  # drop the (partial) line the cut falls into
            first = skipped + 2
        data = fh.read().decode("utf-8", errors="replace")
    return parse_lines(data.splitlines(), first), size


def query(path, min_severity=0, text="", limit=200, offset=0, source=""):
    entries, size = read_file(path)
    text = (text or "").lower()
    out = [e for e in entries
           if e["severity"] >= min_severity
           and (not text or text in e["message"].lower() or text in e["source"].lower())
           and (not source or e["source"] == source)]
    out.reverse()  # newest first
    counts = Counter(e["level"] for e in entries)
    return {
        "size": size,
        "total": len(out),
        "counts": {k: counts.get(k, 0) for k in SEVERITY.values()},
        "sources": sorted({e["source"] for e in entries if e["source"]}),
        "entries": out[offset:offset + limit],
    }


def template(message):
    """Normalises a log message into a pattern: numbers, paths and quoted values replaced."""
    first = message.split("\n", 1)[0]
    t = _QUOTED_RE.sub("'*'", first)
    t = _PATH_RE.sub("<path>", t)
    t = _NUM_RE.sub("<n>", t)
    return re.sub(r"\s+", " ", t).strip()


def insights(path, min_severity=1, top=15):
    """Groups warnings/errors into recurring patterns ("what keeps going wrong")."""
    entries, size = read_file(path)
    groups = {}
    for e in entries:
        if e["severity"] < min_severity:
            continue
        key = (e["source"], template(e["message"]))
        g = groups.get(key)
        if g is None:
            g = groups[key] = {"source": e["source"], "pattern": key[1], "count": 0,
                               "maxSeverity": 0, "first": e["ts"], "last": e["ts"],
                               "example": e["message"].split("\n", 1)[0]}
        g["count"] += 1
        g["maxSeverity"] = max(g["maxSeverity"], e["severity"])
        g["last"] = e["ts"] or g["last"]
    ranked = sorted(groups.values(), key=lambda g: (-g["maxSeverity"], -g["count"]))
    return {"size": size, "patterns": ranked[:top], "distinct": len(groups)}
