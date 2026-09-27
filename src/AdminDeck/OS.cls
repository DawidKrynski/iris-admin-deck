/// CPU, memory and disk metrics of the environment IRIS runs in (container scope when in Docker).
Class AdminDeck.OS
{

ClassMethod Snapshot() As %String
{
    set paths = [["Install", ($system.Util.InstallDirectory())], ["Manager (mgr)", (##class(%File).ManagerDirectory())]]
    set jrn = ##class(%SYS.Journal.System).GetPrimaryDirectory()
    do:jrn'="" paths.%Push(["Journal", (jrn)])
    set snapshot = ..PySnapshot(paths.%ToJSON())
    quit:'..HideHostDetails() snapshot
    // Public deployments: keep the usage numbers, drop what identifies or fingerprints the host.
    set o = {}.%FromJSON(snapshot)
    do o.%Remove("kernel"), o.%Remove("hostname"), o.%Remove("uptimeSec")
    quit o.%ToJSON()
}

/// Set ^AdminDeck("Settings","HideHostDetails")=1 (in the package namespace) on a public instance
/// to omit kernel version, host name and uptime from the OS metrics.
ClassMethod HideHostDetails() As %Boolean
{
    quit +$get(^AdminDeck("Settings", "HideHostDetails"))
}

ClassMethod PySnapshot(pathsJson As %String) As %String [ Language = python ]
{
from admindeck import bridge
return bridge.os_snapshot(pathsJson)
}

}
