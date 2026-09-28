/// Extension REST API for IRIS Admin Deck, mounted at /admindeck/api (JWT auth).
/// Covers what the SysAdmin API does not expose: log files, OS metrics, log similarity search and backup history.
/// Response envelope mirrors /api/admin: {"status":{"errors":[],"summary":""},"result":...}
Class AdminDeck.REST.Dispatch Extends %CSP.REST
{

Parameter CONTENTTYPE = "application/json";

Parameter CHARSET = "utf-8";

Parameter HandleCorsRequest = 0;

XData UrlMap [ XMLNamespace = "http://www.intersystems.com/urlmap" ]
{
<Routes>
  <Route Url="/whoami" Method="GET" Call="WhoAmI"/>
  <Route Url="/logs/files" Method="GET" Call="LogFiles"/>
  <Route Url="/logs/:file" Method="GET" Call="GetLog"/>
  <Route Url="/logs/:file/insights" Method="GET" Call="GetInsights"/>
  <Route Url="/logs/:file/index" Method="POST" Call="IndexLog"/>
  <Route Url="/search/similar" Method="GET" Call="Similar"/>
  <Route Url="/search/status" Method="GET" Call="SearchStatus"/>
  <Route Url="/os" Method="GET" Call="GetOS"/>
  <Route Url="/metrics" Method="GET" Call="GetMetrics"/>
  <Route Url="/apperrors" Method="GET" Call="GetAppErrors"/>
  <Route Url="/backups" Method="GET" Call="GetBackups"/>
</Routes>
}

/// JSON only: never sniffed as another type, never cached, never rendered in a frame.
ClassMethod OnPreDispatch(pUrl As %String, pMethod As %String, ByRef pContinue As %Boolean) As %Status
{
    do %response.SetHeader("X-Content-Type-Options", "nosniff")
    do %response.SetHeader("Cache-Control", "no-store")
    do %response.SetHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
    quit $$$OK
}

ClassMethod WhoAmI() As %Status
{
    // serverTime: the instance's local clock, for screens that must not trust the browser's (audit purge)
    quit ..Reply({"username": ($username), "roles": ($roles), "canOperate": (##class(AdminDeck.Util).CanOperate()),
        "version": ($zversion), "embeddedPython": (..PythonVersion()), "serverTime": ($zdatetime($horolog, 3))})
}

ClassMethod PythonVersion() As %String [ Language = python ]
{
import sys
return sys.version.split()[0]
}

ClassMethod LogFiles() As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    quit ..Reply(##class(AdminDeck.Util).ListLogFiles())
}

ClassMethod GetLog(file As %String) As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    set path = ##class(AdminDeck.Util).LogPath(file)
    // A missing log is an unavailable source, not an empty one
    quit:(path="")||'##class(%File).Exists(path) ..NotFound(file)
    set json = ##class(AdminDeck.Logs).Query(path, +%request.Get("severity", 0), %request.Get("q"),
        ..Bound(%request.Get("limit", 200), 1, 2000), ..Bound(%request.Get("offset", 0), 0, 1000000), %request.Get("source"))
    quit ..Reply({}.%FromJSON(json))
}

ClassMethod GetInsights(file As %String) As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    set path = ##class(AdminDeck.Util).LogPath(file)
    // A missing log is an unavailable source, not an empty one
    quit:(path="")||'##class(%File).Exists(path) ..NotFound(file)
    set json = ##class(AdminDeck.Logs).Insights(path, ..Bound(%request.Get("severity", 1), 0, 3), ..Bound(%request.Get("top", 15), 1, 100))
    quit ..Reply({}.%FromJSON(json))
}

ClassMethod IndexLog(file As %String) As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    quit:##class(AdminDeck.Util).LogPath(file)="" ..NotFound(file)
    set sc = ##class(AdminDeck.VectorSearch).Reindex(file, .count)
    quit:$$$ISERR(sc) ..Fail(sc)
    quit ..Reply({"file": (file), "indexed": (count)})
}

ClassMethod Similar() As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    set text = %request.Get("q")
    quit:text="" ..Fail($$$ERROR($$$GeneralError, "Parameter q is required"), 400)
    set file = %request.Get("file")
    quit:(file'="")&&(##class(AdminDeck.Util).LogPath(file)="") ..NotFound(file)
    quit ..Reply(##class(AdminDeck.VectorSearch).Similar(text, file, ..Bound(%request.Get("k", 10), 1, 100), ..Bound(%request.Get("severity", 0), 0, 3)))
}

ClassMethod SearchStatus() As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    quit ..Reply(##class(AdminDeck.VectorSearch).Status())
}

ClassMethod GetOS() As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    quit ..Reply({}.%FromJSON(##class(AdminDeck.OS).Snapshot()))
}

ClassMethod GetMetrics() As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    quit ..Reply(##class(AdminDeck.Metrics).History())
}

ClassMethod GetAppErrors() As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    // A failed query is reported as an error, never as an empty (healthy-looking) log.
    set sc = $$$OK
    try {
        set errors = ##class(AdminDeck.AppErrors).List(..Bound(%request.Get("days", 7), 1, 365), ..Bound(%request.Get("limit", 300), 1, 5000))
    } catch ex {
        set sc = ex.AsStatus()
    }
    quit:$$$ISERR(sc) ..Fail(sc)
    quit ..Reply(errors)
}

/// Backup definitions, backup tasks and backup history (read-only).
ClassMethod GetBackups() As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    // A failed read is reported as an error, never as "no backups".
    set sc = $$$OK
    try {
        set summary = ##class(AdminDeck.Backups).Summary(..Bound(%request.Get("limit", 200), 1, 2000))
    } catch ex {
        set sc = ex.AsStatus()
    }
    quit:$$$ISERR(sc) ..Fail(sc)
    quit ..Reply(summary)
}

/// --- helpers ---
ClassMethod Bound(value, min As %Integer, max As %Integer) As %Integer
{
    set v = +value
    quit $select(v<min: min, v>max: max, 1: v\1)
}

ClassMethod Reply(result) As %Status
{
    write {"status": {"errors": [], "summary": ""}, "result": (result)}.%ToJSON()
    quit $$$OK
}

ClassMethod Fail(sc As %Status, httpStatus As %Integer = 500) As %Status
{
    set %response.Status = $case(httpStatus, 400: ..#HTTP400BADREQUEST, 403: ..#HTTP403FORBIDDEN, 404: ..#HTTP404NOTFOUND, : ..#HTTP500INTERNALSERVERERROR)
    set msg = $system.Status.GetErrorText(sc)
    write {"status": {"errors": [{"error": (msg)}], "summary": (msg)}, "result": null}.%ToJSON()
    quit $$$OK
}

ClassMethod Forbidden() As %Status
{
    quit ..Fail($$$ERROR($$$GeneralError, "Requires %Admin_Operate:USE"), 403)
}

ClassMethod NotFound(what As %String) As %Status
{
    quit ..Fail($$$ERROR($$$GeneralError, "Unknown log file: "_what), 404)
}

}
