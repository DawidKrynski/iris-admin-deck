/// Extension REST API for IRIS Admin Deck, mounted at /admindeck/api (JWT auth).
/// Covers what the SysAdmin API does not expose: log files, OS metrics, log similarity search, backup history,
/// Interoperability productions (status, and start/stop/update/recover checked against %Ens_ProductionRun)
/// and the log of changes made through Admin Deck.
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
  <Route Url="/interop" Method="GET" Call="GetInterop"/>
  <Route Url="/interop/:namespace" Method="GET" Call="GetInteropNamespace"/>
  <Route Url="/interop/:namespace/:action" Method="POST" Call="InteropAction"/>
  <Route Url="/changes" Method="POST" Call="RecordChange"/>
  <Route Url="/changes" Method="GET" Call="ListChanges"/>
  <Route Url="/restapps" Method="GET" Call="RestApps"/>
  <Route Url="/restapps/routes" Method="GET" Call="RestAppRoutes"/>
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

/// Interoperability: every namespace, and for those with Interoperability enabled the production state.
ClassMethod GetInterop() As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    set sc = $$$OK
    try {
        set overview = ##class(AdminDeck.Interop).Overview()
    } catch ex {
        set sc = ex.AsStatus()
    }
    quit:$$$ISERR(sc) ..Fail(sc)
    quit ..Reply(overview)
}

/// Production of one namespace with its items, queues and recent errors.
ClassMethod GetInteropNamespace(namespace As %String) As %Status
{
    quit:'##class(AdminDeck.Util).CanOperate() ..Forbidden()
    set sc = ##class(AdminDeck.Interop).CheckNamespace(namespace)
    quit:$$$ISERR(sc) ..Fail(sc, 404)
    try {
        set status = ##class(AdminDeck.Interop).Status(namespace, 1)
        do status.%Set("canRun", ##class(AdminDeck.Interop).CanRun(), "boolean")
    } catch ex {
        set sc = ex.AsStatus()
    }
    quit:$$$ISERR(sc) ..Fail(sc)
    quit ..Reply(status)
}

/// Start, stop, update or recover the production of a namespace. The body names the production:
/// {"production": "<class>"} — the one to start, or the one expected to be current for stop / update / recover
/// (409 Conflict when another production is current by then).
/// Privileges are checked here and again in AdminDeck.Interop.Act; the reply is the state read back afterwards.
ClassMethod InteropAction(namespace As %String, action As %String) As %Status
{
    quit:'##class(AdminDeck.Interop).CanRun() ..Forbidden("Requires %Admin_Operate:USE and %Ens_ProductionRun:USE")
    quit:'$listfind($listbuild("start", "stop", "update", "recover"), action) ..Fail($$$ERROR($$$GeneralError, "Unknown action "_action), 400)
    set sc = ##class(AdminDeck.Interop).CheckNamespace(namespace)
    quit:$$$ISERR(sc) ..Fail(sc, 404)
    set production = ""
    try {
        set body = $select($isobject(%request.Content) && %request.Content.Size: {}.%FromJSON(%request.Content), 1: {})
        set production = body.%Get("production")
    } catch ex {
        set sc = $$$ERROR($$$GeneralError, "Request body must be JSON")
    }
    quit:$$$ISERR(sc) ..Fail(sc, 400)
    quit:'##class(AdminDeck.Interop).ValidName(production)&&'((action="recover")&&(production="")) ..Fail($$$ERROR($$$GeneralError, "Body must name the production class: {""production"": ""My.Production""}"_$select(action="start": "", 1: " (the production expected to be current)")), 400)
    set sc = ##class(AdminDeck.Interop).Act(namespace, action, production, .result, .conflict)
    quit:$$$ISERR(sc) ..Fail(sc, $select(conflict: 409, $system.Status.GetErrorText(sc)["does not exist": 404, 1: 500))
    quit ..Reply(result)
}

/// Records a change the caller made through Admin Deck: {what, calls: [{method, path}], outcome, details}.
/// Any signed-in user may record their own changes; the username is always $username, never from the body.
ClassMethod RecordChange() As %Status
{
    set sc = $$$OK
    try {
        set body = $select($isobject(%request.Content) && %request.Content.Size: {}.%FromJSON(%request.Content), 1: "")
    } catch ex {
        set sc = $$$ERROR($$$GeneralError, "Request body must be JSON")
    }
    quit:$$$ISERR(sc) ..Fail(sc, 400)
    set sc = ##class(AdminDeck.Changes).Record(body, $username, .entry)
    quit:$$$ISERR(sc) ..Fail(sc, $select($system.Status.GetErrorText(sc)["busy": 500, 1: 400))
    quit ..Reply(entry)
}

/// The change log, newest first. Reading other users' changes needs an admin privilege.
ClassMethod ListChanges() As %Status
{
    quit:'##class(AdminDeck.Util).CanReadChanges() ..Forbidden("Requires %Admin_Secure:USE or %Admin_Operate:USE")
    quit ..Reply(##class(AdminDeck.Changes).List(..Bound(%request.Get("limit", 200), 1, ##class(AdminDeck.Changes).#KEEP),
        %request.Get("user"), %request.Get("q")))
}

/// REST applications of this instance (what GET /api/mgmnt/ lists; /api/mgmnt itself refuses the JWT).
ClassMethod RestApps() As %Status
{
    quit:'##class(AdminDeck.RestApps).CanRead() ..Forbidden("Requires %Admin_Operate:USE or %Development:USE")
    set sc = $$$OK
    try {
        set list = ##class(AdminDeck.RestApps).List()
    } catch ex {
        set sc = ex.AsStatus()
    }
    quit:$$$ISERR(sc) ..Fail(sc)
    quit ..Reply(list)
}

/// Routes of one REST application: ?app=/web/app/name. Reads only the dispatch class of that application
/// (UrlMap, and the OpenAPI spec of a spec-first application); 404 for an unknown app or one without a class.
ClassMethod RestAppRoutes() As %Status
{
    quit:'##class(AdminDeck.RestApps).CanRead() ..Forbidden("Requires %Admin_Operate:USE or %Development:USE")
    set app = %request.Get("app"), out = ""
    quit:'##class(AdminDeck.RestApps).ValidApp(app) ..Fail($$$ERROR($$$GeneralError, "Parameter app must be a web application name such as /api/mgmnt"), 400)
    try {
        set sc = ##class(AdminDeck.RestApps).Describe(app, .out)
    } catch ex {
        set sc = ex.AsStatus()
    }
    quit:$$$ISERR(sc) ..Fail(sc, $select(out="": 404, 1: 500))
    quit ..Reply(out)
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
    set %response.Status = $case(httpStatus, 400: ..#HTTP400BADREQUEST, 403: ..#HTTP403FORBIDDEN, 404: ..#HTTP404NOTFOUND, 409: ..#HTTP409CONFLICT, : ..#HTTP500INTERNALSERVERERROR)
    set msg = $system.Status.GetErrorText(sc)
    write {"status": {"errors": [{"error": (msg)}], "summary": (msg)}, "result": null}.%ToJSON()
    quit $$$OK
}

ClassMethod Forbidden(message As %String = "Requires %Admin_Operate:USE") As %Status
{
    quit ..Fail($$$ERROR($$$GeneralError, message), 403)
}

ClassMethod NotFound(what As %String) As %Status
{
    quit ..Fail($$$ERROR($$$GeneralError, "Unknown log file: "_what), 404)
}

}
