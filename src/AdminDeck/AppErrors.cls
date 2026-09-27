/// Application error log (what the classic portal shows under System Logs > Application Errors):
/// errors recorded by ^%ETN in every namespace, read through SYS.ApplicationError.
Class AdminDeck.AppErrors
{

/// Newest first: [{namespace, ts, number, message, pid, username, line}] from the last `days` days,
/// at most `limit` entries. Memory stays bounded by `limit` however many errors were logged.
/// Throws when a query fails, so callers can tell "no errors" from "could not read".
ClassMethod List(days As %Integer = 7, limit As %Integer = 500) As %DynamicArray
{
    new $namespace
    set $namespace = "%SYS"
    set cutoff = $horolog - days, kept = 0
    set namespaces = ..Query("NamespaceList")
    while ..Next(namespaces) {
        set ns = namespaces.GetData(1)
        set dates = ..Query("DateList", ns)
        while ..Next(dates) {
            set day = dates.GetData(1), h = $zdateh(day, 1, , , , , , , "")
            continue:(h = "")||(h < cutoff)
            set errors = ..Query("ErrorList", ns, day)
            while ..Next(errors) {
                set ts = $zdate(h, 3)_" "_errors.GetData(3)
                // Keep only the newest `limit`: once full, an entry older than the oldest kept one is skipped,
                // otherwise it replaces that oldest one.
                if kept >= limit {
                    set oldest = $order(newest(""))
                    continue:ts']]oldest
                    kill newest(oldest, $order(newest(oldest, ""))) set kept = kept - 1
                }
                set newest(ts, $increment(seq)) = {
                    "namespace": (ns), "ts": (ts), "number": (+errors.GetData(1)),
                    "message": ($zstrip(errors.GetData(2), "<>W")),
                    "pid": (errors.GetData(5)), "username": (errors.GetData(6)), "line": (errors.GetData(7))
                }
                set kept = kept + 1
            }
        }
    }
    // Newest first: timestamps descending, and within one second the later-read entry first.
    set out = [], ts = ""
    for {
        set ts = $order(newest(ts), -1)
        quit:ts=""
        set k = ""
        for {
            set k = $order(newest(ts, k), -1)
            quit:k=""
            do out.%Push(newest(ts, k))
        }
    }
    quit out
}

/// Runs a SYS.ApplicationError query; throws on failure.
ClassMethod Query(name As %String, args...) As %ResultSet [ Private ]
{
    set rs = ##class(%ResultSet).%New("SYS.ApplicationError:"_name)
    $$$ThrowOnError(rs.Execute(args...))
    quit rs
}

/// Advances a result set; throws when fetching fails (instead of looking like the end of the data).
ClassMethod Next(rs As %ResultSet) As %Boolean [ Private ]
{
    set more = rs.Next(.sc)
    $$$ThrowOnError(sc)
    quit more
}

}
