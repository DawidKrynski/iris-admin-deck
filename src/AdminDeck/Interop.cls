/// Interoperability productions (what the classic portal shows under Interoperability > Production
/// Monitor): which namespaces have Interoperability enabled, the state of their production, its items,
/// queues and recent errors, and start / stop / update / recover through Ens.Director.
/// The SysAdmin API has no production endpoints, so this is extension code; every action is checked here
/// against the caller's own privileges (%Admin_Operate:USE and %Ens_ProductionRun:USE), never in the UI.
Class AdminDeck.Interop
{

/// Ens.Director production states (EnsConstants.inc, $$$eProductionState*), spelled out because the
/// include file only exists in Interoperability-enabled namespaces.
ClassMethod StateName(state As %Integer) As %String
{
    quit $case(+state, 1: "Running", 2: "Stopped", 3: "Suspended", 4: "Troubled", 5: "NetworkStopped", : "Unknown")
}

/// Production class names and namespaces are plain identifiers: anything else is refused before use.
ClassMethod ValidName(name As %String) As %Boolean
{
    quit $match(name, "^%?[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*)*$")
}

ClassMethod ValidNamespace(ns As %String) As %Boolean
{
    quit $match(ns, "^%?[A-Za-z0-9_-]{1,64}$")
}

/// True when the caller may start, stop or update productions.
ClassMethod CanRun() As %Boolean
{
    quit ##class(AdminDeck.Util).CanOperate() && $system.Security.Check("%Ens_ProductionRun", "USE")
}

/// [{namespace, enabled}] for every real namespace (no implicit ^^dir namespaces), sorted by name.
ClassMethod Namespaces() As %DynamicArray
{
    do ##class(%SYS.Namespace).ListAll(.all)
    set out = [], ns = ""
    for {
        set ns = $order(all(ns))
        quit:ns=""
        continue:$extract(ns)="^"
        set row = {"namespace": (ns)}
        do row.%Set("enabled", ''##class(%EnsembleMgr).IsEnsembleNamespace(ns), "boolean")
        do out.%Push(row)
    }
    quit out
}

/// Overview of every namespace: {namespaces: [{namespace, enabled, production, state, ...}], canRun}.
/// A namespace the caller cannot read is reported with its error, not left out.
ClassMethod Overview() As %DynamicObject
{
    set list = ..Namespaces(), out = []
    set it = list.%GetIterator()
    while it.%GetNext(, .row) {
        if row.enabled {
            set sc = $$$OK
            try {
                set detail = ..Status(row.namespace, 0)
            } catch ex {
                set sc = ex.AsStatus()
            }
            if $$$ISERR(sc) {
                set row.error = $system.Status.GetErrorText(sc)
            } else {
                set dit = detail.%GetIterator()
                // Keep JSON types: a copied false would otherwise become the (truthy) string "0"
                while dit.%GetNext(.k, .v, .type) {
                    if $listfind($listbuild("boolean", "null", "number"), type) { do row.%Set(k, v, type) } else { do row.%Set(k, v) }
                }
            }
        }
        do out.%Push(row)
    }
    set result = {"namespaces": (out)}
    do result.%Set("canRun", ..CanRun(), "boolean")
    quit result
}

/// Status of the production in `ns`: {namespace, production, state, stateCode, needsUpdate, updateReason,
/// errorsLastHour, productions:[names], items:[...], queues:[...]} (items/queues only when `full`).
/// Throws when the namespace is unknown or has no Interoperability.
ClassMethod Status(ns As %String, full As %Boolean = 1) As %DynamicObject
{
    $$$ThrowOnError(..CheckNamespace(ns))
    new $namespace
    set $namespace = ns
    $$$ThrowOnError(##class(Ens.Director).GetProductionStatus(.name, .state, 2, 1))
    // A stopped production has no name here; the one started last (if its class still exists) is what Start offers
    set last = $get(^Ens.Configuration("csp", "LastProduction"))
    set:(last'="")&&'##class(%Dictionary.CompiledClass).%ExistsId(last) last = ""
    set out = {"namespace": (ns), "production": (name), "stateCode": (+state), "state": (..StateName(state)),
        "lastProduction": (last), "updateReason": "", "productions": (..Productions())}
    do out.%Set("needsUpdate", 0, "boolean")
    if +state = 1 {
        do out.%Set("needsUpdate", ''##class(Ens.Director).ProductionNeedsUpdate(.reason), "boolean")
        set out.updateReason = $get(reason)
    }
    set out.errorsLastHour = ..ErrorCount(3600)
    if full {
        set out.items = ..Items($select(name'="": name, 1: out.lastProduction), (+state = 1))
        set out.queues = ..Queues()
        set out.recentErrors = ..RecentErrors(20)
    }
    quit out
}

/// Production classes compiled in the current namespace.
ClassMethod Productions() As %DynamicArray [ Private ]
{
    set out = [], rs = ##class(%SQL.Statement).%ExecDirect(, "SELECT Name FROM Ens_Config.Production ORDER BY Name")
    if rs.%SQLCODE < 0 { $$$ThrowStatus($$$ERROR($$$SQLError, rs.%SQLCODE, rs.%Message)) }
    while rs.%Next() { do out.%Push(rs.Name) }
    quit out
}

/// Configuration items of `production` with their runtime status when it is running:
/// [{name, className, category, enabled, poolSize, status, adapterState, lastActivity, queue, count, errorsLastHour}]
ClassMethod Items(production As %String, running As %Boolean) As %DynamicArray [ Private ]
{
    set out = []
    quit:production="" out
    // Runtime status per host, as the Production Monitor shows it
    if running {
        set rs = ##class(%ResultSet).%New("Ens.Util.Statistics:EnumerateHostStatus")
        if $$$ISOK(rs.Execute()) {
            while rs.Next() {
                set host(rs.Get("Name")) = $listbuild(rs.Get("Status"), rs.Get("AdapterState"), rs.Get("LastActivity"), rs.Get("Queue"), rs.Get("Count"))
            }
        }
    }
    // Errors per item in the last hour (Ens_Util.Log Type 2 = Error; TimeLogged is UTC)
    set since = ..UTCAgo(3600)
    set rs = ##class(%SQL.Statement).%ExecDirect(, "SELECT ConfigName, COUNT(*) AS N FROM Ens_Util.Log WHERE Type = 2 AND TimeLogged >= ? GROUP BY ConfigName", since)
    while rs.%Next() { set errs(rs.ConfigName) = rs.N }
    set prod = ##class(Ens.Config.Production).%OpenId(production, 0, .sc)
    quit:'$isobject(prod) out
    for i = 1:1:prod.Items.Count() {
        set item = prod.Items.GetAt(i), n = item.Name, rt = $get(host(n))
        set row = {"name": (n), "className": (item.ClassName), "category": (item.Category), "poolSize": (+item.PoolSize),
            "status": ($select(rt="": $select(item.Enabled&&running: "Unknown", 1: "Inactive"), 1: $listget(rt, 1))),
            "adapterState": ($listget(rt, 2)), "lastActivity": ($listget(rt, 3)),
            "queue": (+$listget(rt, 4)), "count": (+$listget(rt, 5)), "errorsLastHour": (+$get(errs(n)))}
        do row.%Set("enabled", ''item.Enabled, "boolean")
        do out.%Push(row)
    }
    quit out
}

/// Queues with messages waiting: [{name, count}] (largest first).
ClassMethod Queues() As %DynamicArray [ Private ]
{
    set out = [], rs = ##class(%ResultSet).%New("Ens.Queue:Enumerate")
    $$$ThrowOnError(rs.Execute())
    while rs.Next() {
        set sorted(-rs.Get("Count"), rs.Get("Name")) = ""
    }
    set c = ""
    for {
        set c = $order(sorted(c))
        quit:c=""
        set n = ""
        for {
            set n = $order(sorted(c, n))
            quit:n=""
            do out.%Push({"name": (n), "count": (-c)})
        }
    }
    quit out
}

/// Errors logged by the production in the last `seconds`.
ClassMethod ErrorCount(seconds As %Integer) As %Integer [ Private ]
{
    set rs = ##class(%SQL.Statement).%ExecDirect(, "SELECT COUNT(*) AS N FROM Ens_Util.Log WHERE Type = 2 AND TimeLogged >= ?", ..UTCAgo(seconds))
    quit $select(rs.%Next(): +rs.N, 1: 0)
}

/// Newest `limit` error entries of the Event Log: [{time (UTC), item, text}]
ClassMethod RecentErrors(limit As %Integer) As %DynamicArray [ Private ]
{
    set out = [], rs = ##class(%SQL.Statement).%ExecDirect(, "SELECT TOP "_(+limit)_" TimeLogged, ConfigName, Text FROM Ens_Util.Log WHERE Type = 2 ORDER BY ID DESC")
    while rs.%Next() { do out.%Push({"time": (rs.TimeLogged), "item": (rs.ConfigName), "text": ($extract(rs.Text, 1, 500))}) }
    quit out
}

/// UTC timestamp `seconds` ago, in the ODBC format Ens_Util.Log stores.
ClassMethod UTCAgo(seconds As %Integer) As %String [ Private ]
{
    set now = $ztimestamp, secs = (now * 86400) + $piece(now, ",", 2) - seconds
    quit $zdatetime((secs \ 86400)_","_(secs # 86400), 3)
}

/// OK when `ns` names an existing namespace with Interoperability enabled.
ClassMethod CheckNamespace(ns As %String) As %Status
{
    quit:'..ValidNamespace(ns) $$$ERROR($$$GeneralError, "Invalid namespace name")
    quit:'##class(%SYS.Namespace).Exists(ns) $$$ERROR($$$GeneralError, "Namespace "_ns_" does not exist")
    quit:'##class(%EnsembleMgr).IsEnsembleNamespace(ns) $$$ERROR($$$GeneralError, "Interoperability is not enabled in namespace "_ns)
    quit $$$OK
}

/// Runs a production action in `ns`: start `production`, or stop, update or recover the production named
/// `production` — the one the caller saw. Ens.Director acts on whatever production is current, so stop,
/// update and recover are refused (`conflict` = 1) when that is not `production` any more.
/// The caller's privileges are checked here. Returns the production status read back afterwards.
ClassMethod Act(ns As %String, action As %String, production As %String = "", Output result As %DynamicObject, Output conflict As %Boolean) As %Status
{
    set result = "", conflict = 0
    quit:'..CanRun() $$$ERROR($$$GeneralError, "Requires %Admin_Operate:USE and %Ens_ProductionRun:USE")
    quit:'$listfind($listbuild("start", "stop", "update", "recover"), action) $$$ERROR($$$GeneralError, "Unknown action "_action)
    set sc = ..CheckNamespace(ns)
    quit:$$$ISERR(sc) sc
    // A troubled production may have lost its name: recovering it is the one action that may expect none
    quit:'..ValidName(production)&&'((action="recover")&&(production="")) $$$ERROR($$$GeneralError, $select(action="start": "Invalid production name", 1: "Name the production to "_action_" (the one currently shown)"))
    new $namespace
    set $namespace = ns
    quit:(action="start")&&'##class(%Dictionary.CompiledClass).%ExistsId(production) $$$ERROR($$$GeneralError, "Production class "_production_" does not exist in "_ns)
    quit:(action="start")&&'$classmethod(production, "%Extends", "Ens.Production") $$$ERROR($$$GeneralError, production_" is not a production class")
    if action '= "start" {
        set sc = ##class(Ens.Director).GetProductionStatus(.current, .state, 2, 1)
        quit:$$$ISERR(sc) sc
        if current '= production {
            set conflict = 1
            quit $$$ERROR($$$GeneralError, "Refused: the production in "_ns_" is now "_$select(current="": "none", 1: current)_", not "_production_". Reload and try again.")
        }
    }
    // Ens.Director reports progress with WRITE: send it to the null device, never into the JSON reply
    set io = $io, null = $select($zversion(1)=2: "NUL", 1: "/dev/null")
    open null:("W"):2
    set quiet = $test
    use:quiet null
    try {
        if action = "start" {
            set sc = ##class(Ens.Director).StartProduction(production)
        } elseif action = "stop" {
            set sc = ##class(Ens.Director).StopProduction(10, 0)
        } elseif action = "update" {
            set sc = ##class(Ens.Director).UpdateProduction(10, 0)
        } else {
            set sc = ##class(Ens.Director).RecoverProduction()
        }
    } catch ex {
        set sc = ex.AsStatus()
    }
    if quiet {
        use io
        close null
    }
    quit:$$$ISERR(sc) sc
    try {
        set result = ..Status(ns, 0)
    } catch ex {
        set sc = ex.AsStatus()
    }
    quit sc
}

}
