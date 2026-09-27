"""JSON-in/JSON-out entry points called from ObjectScript classes."""
import json

from . import embed, logparse, metrics, osinfo


def logs(path, min_severity=0, text="", limit=200, offset=0, source=""):
    return json.dumps(logparse.query(path, int(min_severity), text, int(limit), int(offset), source))


def insights(path, min_severity=1, top=15):
    return json.dumps(logparse.insights(path, int(min_severity), int(top)))


def os_snapshot(paths_json):
    return json.dumps(osinfo.snapshot([tuple(p) for p in json.loads(paths_json)]))


def cpu_times():
    """"<idle> <total>" CPU jiffies since boot (the dashboard sampler turns two readings into a usage %)."""
    return "%d %d" % osinfo.cpu_times()


def vector(text):
    return embed.to_vector_string(embed.embed(text))


def index_entries(path):
    """Yields rows for the vector index: severity>=1 plus info lines, newest 5000."""
    entries, _ = logparse.read_file(path)
    rows = []
    for e in entries[-5000:]:
        rows.append((e["line"], e["ts"], e["pid"], e["severity"], e["source"],
                     e["message"][:2000], embed.to_vector_string(embed.embed(e["source"] + " " + e["message"]))))
    return rows



def instance_metrics(text):
    return " ".join("-" if v is None else str(v) for v in metrics.summary(text))
