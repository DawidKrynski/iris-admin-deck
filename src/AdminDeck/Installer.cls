/// Post-install configuration for IRIS Admin Deck.
Class AdminDeck.Installer
{

/// Post-install: web application settings, the nightly log reindex task and the metrics sampler.
ClassMethod Configure() As %Status
{
    set sc = ..ConfigureWebApps()
    quit:$$$ISERR(sc) sc
    set sc = ..ScheduleReindex()
    quit:$$$ISERR(sc) sc
    // Initial index so similar-incident search works right after installation
    do ##class(AdminDeck.VectorSearch).Reindex("messages")
    // Dashboard throughput history starts filling right away
    do ##class(AdminDeck.Metrics).Ensure()
    quit $$$OK
}

/// Enables JWT authentication on the extension REST web application so the SPA can
/// log in with the same credentials it uses for /api/admin (no password kept in the browser).
ClassMethod ConfigureWebApps() As %Status
{
    new $namespace
    set $namespace = "%SYS"
    set app = "/admindeck/api"
    quit:'##class(Security.Applications).Exists(app) $$$ERROR($$$GeneralError, "Web application "_app_" not found")
    set props("AutheEnabled") = 32 // password (JWT login needs it); never unauthenticated
    set props("JWTAuthEnabled") = 1
    set props("JWTAccessTokenTimeout") = 300
    set props("JWTRefreshTokenTimeout") = 1800
    set sc = ##class(Security.Applications).Modify(app, .props)
    quit:$$$ISERR(sc) sc
    // UI files are small; expire after 1 s so upgrades are picked up immediately (0 = server default of 1 h)
    kill props
    set props("ServeFilesTimeout") = 1
    quit ##class(Security.Applications).Modify("/admindeck", .props)
}

/// Creates (once) a daily task that refreshes the log vector index at 03:15.
/// Runs in the package namespace: %SYS.Task validates the task class there.
ClassMethod ScheduleReindex(namespace As %String = {$namespace}) As %Status
{
    set rs = ##class(%SQL.Statement).%ExecDirect(, "SELECT ID FROM %SYS.Task WHERE TaskClass = ?", "AdminDeck.Task.ReindexLogs")
    quit:rs.%Next() $$$OK
    set task = ##class(%SYS.Task).%New()
    set task.Name = "Admin Deck: reindex logs"
    set task.Description = "Refreshes the Admin Deck similar-incident index (IRIS Vector Search over log files)"
    set task.NameSpace = namespace
    set task.TaskClass = "AdminDeck.Task.ReindexLogs"
    // Run as the installing user when it is a real account; _SYSTEM otherwise (e.g. OS-authenticated build)
    set task.RunAsUser = $select(($username'="UnknownUser")&&..UserExists($username): $username, 1: "_SYSTEM")
    set task.TimePeriod = 0, task.TimePeriodEvery = 1
    set task.DailyFrequency = 0, task.DailyStartTime = $ztimeh("03:15:00")
    quit task.%Save()
}

ClassMethod UserExists(name As %String) As %Boolean
{
    new $namespace
    set $namespace = "%SYS"
    quit ##class(Security.Users).Exists(name)
}

}
