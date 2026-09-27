"""Host/container OS metrics read from /proc and statvfs (Linux)."""
import os
import time


def cpu_times():
    with open("/proc/stat") as fh:
        parts = fh.readline().split()[1:]
    vals = [int(x) for x in parts]
    idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
    return idle, sum(vals)


def cpu(sample=0.25):
    i1, t1 = cpu_times()
    time.sleep(sample)
    i2, t2 = cpu_times()
    dt = (t2 - t1) or 1
    load1, load5, load15 = os.getloadavg()
    return {"usagePct": round(100.0 * (1 - (i2 - i1) / dt), 1), "cores": os.cpu_count(),
            "load": [round(load1, 2), round(load5, 2), round(load15, 2)]}


def memory():
    info = {}
    with open("/proc/meminfo") as fh:
        for line in fh:
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0]) * 1024
    total = info.get("MemTotal", 0)
    avail = info.get("MemAvailable", info.get("MemFree", 0))
    res = {"total": total, "available": avail, "used": total - avail,
           "usedPct": round(100.0 * (total - avail) / total, 1) if total else 0,
           "swapTotal": info.get("SwapTotal", 0), "swapFree": info.get("SwapFree", 0)}
    limit = _cgroup_limit()
    if limit:
        res["containerLimit"] = limit
    return res


def _cgroup_limit():
    for p in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            with open(p) as fh:
                v = fh.read().strip()
            if v.isdigit() and int(v) < 1 << 60:
                return int(v)
        except OSError:
            pass
    return None


def disks(paths):
    seen, out = set(), []
    for label, path in paths:
        try:
            st = os.statvfs(path)
        except OSError:
            continue
        key = (st.f_fsid, st.f_blocks)
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        out.append({"label": label, "path": path, "total": total, "free": free,
                    "used": total - free,
                    "usedPct": round(100.0 * (total - free) / total, 1) if total else 0,
                    "sameFilesystemAs": next((o["label"] for o in out if o.get("_k") == key), None),
                    "_k": key})
        seen.add(key)
    for o in out:
        o.pop("_k", None)
    return out


def uptime():
    with open("/proc/uptime") as fh:
        return int(float(fh.read().split()[0]))


def snapshot(paths):
    return {"cpu": cpu(), "memory": memory(), "disks": disks(paths), "uptimeSec": uptime(),
            "hostname": os.uname().nodename, "kernel": os.uname().release}
