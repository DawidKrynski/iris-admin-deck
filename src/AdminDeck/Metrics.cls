/// Instance history for the dashboard and the status page. A background job samples, every INTERVAL
/// seconds, global references and CPU usage plus the instance metrics IRIS publishes for monitoring
/// (web requests, gateway and database latency, SQL rate and runtime, system state) into a ring buffer
/// (^IRIS.Temp.AdminDeck("Metrics"), which lives in IRISTEMP and is not journaled), so the charts are
/// already filled when a page opens. The job is started on install and by the first reader, and stops by
/// itself when nobody has read the history for IDLE seconds.
Class AdminDeck.Metrics
{

Parameter INTERVAL = 5;

/// One hour of samples
Parameter KEEP = 720;

Parameter IDLE = 86400;

/// Order of the values in each point (after the unix time). webRequests is the Web Gateway counter since
/// its start, which IRIS refreshes about once a minute; readers turn it into a rate over a longer window.
Parameter FIELDS = "globalRefsPerSec,cpuPct,webRequests,gatewayLatencyMs,dbReadLatencyMs,sqlPerSec,sqlAvgMs,systemState";

/// Samples as JSON: {"interval": 5, "fields": [...], "points": [[unixTime, ...values in FIELDS order], ...], "now": ..., "serverTime": ...}
/// (oldest first; a value IRIS did not publish is null).
ClassMethod History() As %DynamicObject
{
    set ^IRIS.Temp.AdminDeck("Metrics", "read") = $zdatetime($ztimestamp, -2)
    do ..Ensure()
    set points = [], n = $order(^IRIS.Temp.AdminDeck("Metrics", "s", ""), 1, p)
    while n '= "" {
        set point = []
        // "" = not published by IRIS: null for the reader, not zero
        for i = 1:1:$listlength(p) { if $list(p, i) = "" { do point.%Push("", "null") } else { do point.%Push($list(p, i)) } }
        do points.%Push(point)
        set n = $order(^IRIS.Temp.AdminDeck("Metrics", "s", n), 1, p)
    }
    set fields = []
    for i = 1:1:$length(..#FIELDS, ",") { do fields.%Push($piece(..#FIELDS, ",", i)) }
    // now: unix time on the server (charts are anchored to it, not to the browser clock);
    // serverTime: the instance's local clock, which log timestamps use
    quit {"interval": (..#INTERVAL), "fields": (fields), "points": (points), "now": ($zdatetime($ztimestamp, -2)), "serverTime": ($zdatetime($horolog, 3))}
}

/// Starts the sampler unless it is running (a running sampler holds the lock).
ClassMethod Ensure()
{
    lock +^IRIS.Temp.AdminDeck("Metrics", "sampler"):0
    quit:'$test
    lock -^IRIS.Temp.AdminDeck("Metrics", "sampler")
    job ..Run()
}

ClassMethod Run()
{
    lock +^IRIS.Temp.AdminDeck("Metrics", "sampler"):0
    quit:'$test
    set ^IRIS.Temp.AdminDeck("Metrics", "read") = $get(^IRIS.Temp.AdminDeck("Metrics", "read"), $zdatetime($ztimestamp, -2))
    // A new run starts a new history: samples from an earlier run would hide the gap between them.
    kill ^IRIS.Temp.AdminDeck("Metrics", "s"), ^IRIS.Temp.AdminDeck("Metrics", "error")
    try {
        set prev = ..Counters()
        while $zdatetime($ztimestamp, -2) - ^IRIS.Temp.AdminDeck("Metrics", "read") < ..#IDLE {
            hang ..#INTERVAL
            set cur = ..Counters()
            set secs = $list(cur, 1) - $list(prev, 1), jiffies = $list(cur, 4) - $list(prev, 4)
            set refs = $select(secs > 0: $normalize(($list(cur, 2) - $list(prev, 2)) / secs, 0), 1: 0)
            set cpu = $select(jiffies > 0: $normalize(100 - (100 * ($list(cur, 3) - $list(prev, 3)) / jiffies), 1), 1: 0)
            set n = $increment(^IRIS.Temp.AdminDeck("Metrics", "n"))
            set ^IRIS.Temp.AdminDeck("Metrics", "s", n) = $listbuild($zdatetime($ztimestamp, -2), refs, cpu) _ $list(cur, 5, 10)
            kill ^IRIS.Temp.AdminDeck("Metrics", "s", n - ..#KEEP)
            set prev = cur
        }
    } catch ex {
        set ^IRIS.Temp.AdminDeck("Metrics", "error") = ex.DisplayString()
    }
    lock -^IRIS.Temp.AdminDeck("Metrics", "sampler")
}

/// $listbuild(seconds, total global references, idle CPU jiffies, total CPU jiffies, web requests since start,
/// gateway latency ms, slowest database read ms, SQL statements/s, average SQL ms, system state)
ClassMethod Counters() As %List
{
    set cpu = ..CpuTimes()
    new $namespace
    set $namespace = "%SYS"
    set g = ##class(SYS.Stats.Global).Sample()
    set m = ..InstanceMetrics(##class(SYS.Monitor.SAM.Sensors).PrometheusMetrics())
    set list = $listbuild($zhorolog, g.RefLocal + g.RefRemote, $piece(cpu, " "), $piece(cpu, " ", 2))
    for i = 1:1:6 { set v = $piece(m, " ", i), list = list _ $listbuild($select(v = "-": "", 1: +v)) }
    quit list
}

ClassMethod CpuTimes() As %String [ Language = python ]
{
from admindeck import bridge
return bridge.cpu_times()
}

ClassMethod InstanceMetrics(text As %String) As %String [ Language = python ]
{
from admindeck import bridge
return bridge.instance_metrics(text)
}

}
