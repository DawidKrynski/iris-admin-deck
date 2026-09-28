/// HTTP tests for the local container: zpm "iris-admin-deck test" in USER.
Class AdminDeck.Tests.Dispatch Extends %UnitTest.TestCase
{

Property LimitedUser As %String;

Property LimitedPassword As %String;

Method OnBeforeAllTests() As %Status
{
    new $namespace
    set $namespace = "%SYS"
    set name = "zzDeckHttp"_$translate($system.Util.CreateGUID(), "-")
    set ..LimitedPassword = "T3st!"_$translate($system.Util.CreateGUID(), "-")
    // %Operator includes %Admin_Operate. %SQL is limited and cannot operate or read changes.
    set p("Roles") = "%SQL", p("Password") = ..LimitedPassword
    set p("Enabled") = 1, p("ChangePassword") = 0, p("PasswordNeverExpires") = 1
    set sc = ##class(Security.Users).Create(name, .p)
    if $$$ISOK(sc) { set ..LimitedUser = name }
    quit sc
}

Method OnAfterAllTests() As %Status
{
    new $namespace
    set $namespace = "%SYS", sc = $$$OK
    if ..LimitedUser '= "" { set sc = ##class(Security.Users).Delete(..LimitedUser) }
    set ..LimitedPassword = ""
    quit sc
}

/// A fresh client for every call: no cookies or credentials leak between tests.
Method Request(method As %String, path As %String, auth As %String = "admin", body = "") As %Net.HttpResponse
{
    set http = ##class(%Net.HttpRequest).%New()
    set http.Server = "127.0.0.1", http.Port = 52773, http.Https = 0, http.Timeout = 60
    set http.FollowRedirect = 0
    if auth = "admin" {
        set http.Username = "SuperUser", http.Password = "SYS"
    } elseif auth = "limited" {
        set http.Username = ..LimitedUser, http.Password = ..LimitedPassword
    }
    set http.InitiateAuthentication = $select(auth="none": "", 1: "Basic")
    if $isobject(body) {
        set http.ContentType = "application/json"
        do http.EntityBody.Write(body.%ToJSON())
    }
    set sc = http.Send(method, "/admindeck/api"_path)
    do $$$AssertStatusOK(sc, method_" "_path_": transport")
    $$$ThrowOnError(sc)
    quit http.HttpResponse
}

/// Check both the HTTP status and the extension's JSON envelope.
Method Reply(response As %Net.HttpResponse, expected As %Integer) As %DynamicObject
{
    do $$$AssertEquals(response.StatusCode, expected, "HTTP status")
    set json = {}.%FromJSON(response.Data)
    do $$$AssertTrue(json.%IsDefined("result"), "result key present")
    if expected = 200 {
        do $$$AssertEquals(json.status.errors.%Size(), 0, "no errors")
        do $$$AssertEquals(json.status.summary, "", "empty error summary")
    } else {
        do $$$AssertTrue(json.status.errors.%Size() > 0, "JSON errors present")
        do $$$AssertNotEquals(json.status.errors.%Get(0).error, "", "error text present")
        do $$$AssertNotEquals(json.status.summary, "", "error summary present")
        do $$$AssertEquals(json.%GetTypeOf("result"), "null", "no result on failure")
    }
    quit json
}

Method TestUnauthenticated()
{
    set response = ..Request("GET", "/whoami", "none")
    // Authentication is rejected by CSP before dispatch; its body need not use our JSON envelope.
    do $$$AssertEquals(response.StatusCode, 401, "credentials required")
}

Method TestLimitedLogsForbidden()
{
    do ..Reply(..Request("GET", "/logs/files", "limited"), 403)
}

Method TestLimitedInteropForbidden()
{
    do ..Reply(..Request("GET", "/interop", "limited"), 403)
    do ..Reply(..Request("POST", "/interop/USER/start", "limited", {"production": "Bad.Name"}), 403)
}

Method TestLimitedChangesForbidden()
{
    do ..Reply(..Request("GET", "/changes", "limited"), 403)
}

Method TestInvalidLogKey()
{
    do ..Reply(..Request("GET", "/logs/bad%3Akey"), 400)
    do ..Reply(..Request("GET", "/logs/messages.old_bad-name"), 400)
}

Method TestUnknownLogFile()
{
    set key = "messages.old_"_$translate($system.Util.CreateGUID(), "-")
    do $$$AssertEquals(##class(AdminDeck.Util).LogPath(key), "", "fixture log does not exist")
    do ..Reply(..Request("GET", "/logs/"_key), 404)
    do ..Reply(..Request("GET", "/logs/zzNoSuchLog"), 404)
}

Method TestInvalidProductionName()
{
    do ..Reply(..Request("POST", "/interop/USER/start", "admin", {"production": "Bad;Name"}), 400)
}

Method TestInvalidRestApp()
{
    do ..Reply(..Request("GET", "/restapps/routes?app=api"), 400)
    do ..Reply(..Request("GET", "/restapps/routes?app=%2Fa%2F..%2Fb"), 400)
}

Method TestUnknownRestApp()
{
    set name = "zzDeckHttp"_$translate($system.Util.CreateGUID(), "-")
    do ..Reply(..Request("GET", "/restapps/routes?app=%2F"_name), 404)
}

Method TestWhoAmI()
{
    set result = ..Reply(..Request("GET", "/whoami"), 200).result
    do $$$AssertEquals(result.username, "SuperUser", "authenticated identity")
    do $$$AssertTrue(result.canOperate, "administrator can operate")
    do $$$AssertTrue(result.%IsDefined("roles") && result.%IsDefined("version") && result.%IsDefined("embeddedPython"), "identity keys")
    do $$$AssertTrue($match(result.serverTime, "^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$"), "server timestamp")
    set result = ..Reply(..Request("GET", "/whoami", "limited"), 200).result
    do $$$AssertEquals(result.username, ..LimitedUser, "limited credentials authenticate")
    do $$$AssertTrue('result.canOperate, "limited user has no operate privilege")
}

Method TestMetrics()
{
    set result = ..Reply(..Request("GET", "/metrics"), 200).result
    do $$$AssertEquals(result.interval, 5, "sampling interval")
    do $$$AssertEquals(result.%GetTypeOf("fields"), "array", "field names")
    do $$$AssertEquals(result.%GetTypeOf("points"), "array", "history points (may initially be empty)")
    do $$$AssertEquals(result.fields.%Size(), 8, "metric fields")
    do $$$AssertTrue(result.%IsDefined("now") && result.%IsDefined("serverTime"), "server clock keys")
}

Method TestChangesRoundTrip()
{
    // As in Extension: isolate the log so the POST cannot trim a real entry at the retention limit.
    // Run on the local test container without concurrent change-log writers.
    merge saved = ^AdminDeck("Changes")
    kill ^AdminDeck("Changes")
    try {
        set marker = "Dispatch round trip "_$system.Util.CreateGUID()
        set body = {"what": (marker), "outcome": "verified", "details": "HTTP test",
            "calls": [{"method": "get", "path": "/admindeck/api/whoami"}], "user": "Someone Else"}
        // An ordinary signed-in user may POST; an administrator performs the GET.
        set entry = ..Reply(..Request("POST", "/changes", "limited", body), 200).result
        do $$$AssertTrue(entry.id > 0, "assigned id")
        do $$$AssertNotEquals(entry.time, "", "server timestamp")
        do $$$AssertEquals(entry.user, ..LimitedUser, "caller identity cannot be spoofed")
        do $$$AssertEquals(entry.what, marker, "description stored")
        do $$$AssertEquals(entry.outcome, "verified", "outcome stored")
        do $$$AssertEquals(entry.details, "HTTP test", "details stored")
        do $$$AssertEquals(entry.calls.%Get(0).method, "GET", "method normalised")
        set rows = ..Reply(..Request("GET", "/changes?user="_..LimitedUser), 200).result
        do $$$AssertEquals(rows.%Size(), 1, "posted entry listed")
        do $$$AssertEquals(rows.%Get(0).%ToJSON(), entry.%ToJSON(), "GET returns the recorded entry")
    } catch ex {
        do $$$AssertStatusOK(ex.AsStatus(), "change round trip completed")
    }
    kill ^AdminDeck("Changes")
    merge ^AdminDeck("Changes") = saved
}

Method TestInteropOverview()
{
    set result = ..Reply(..Request("GET", "/interop"), 200).result
    do $$$AssertEquals(result.%GetTypeOf("namespaces"), "array", "namespaces listed")
    do $$$AssertEquals(result.%GetTypeOf("canRun"), "boolean", "canRun JSON type")
    do $$$AssertTrue(result.canRun, "administrator can run productions")
    set found = 0, it = result.namespaces.%GetIterator()
    while it.%GetNext(, .row) { set:row.namespace="USER" found = 1 }
    do $$$AssertTrue(found, "USER listed")
}

Method TestInteropStopConflict()
{
    new $namespace
    set $namespace = "USER"
    if '##class(%EnsembleMgr).IsEnsembleNamespace("USER") {
        do $$$AssertSkipped("Interoperability is not enabled in USER")
        quit
    }
    set sc = ##class(Ens.Director).GetProductionStatus(.running, .state, 2, 1)
    do $$$AssertStatusOK(sc, "initial production state")
    quit:$$$ISERR(sc)
    if (running '= "") || (+state '= 2) {
        do $$$AssertSkipped("USER already has an active, suspended or troubled production")
        quit
    }
    set name = "AdminDeck.Tests.zzHttp"_$translate($system.Util.CreateGUID(), "-")
    set hadLast = $data(^Ens.Configuration("csp", "LastProduction"), last)
    try {
        set sc = ..CreateProduction(name)
        do $$$AssertStatusOK(sc, "fixture production compiled")
        $$$ThrowOnError(sc)
        set result = ..Reply(..Request("POST", "/interop/USER/start", "admin", {"production": (name)}), 200).result
        do $$$AssertEquals(result.production, name, "fixture started")
        do $$$AssertEquals(result.state, "Running", "running read-back")
        set json = ..Reply(..Request("POST", "/interop/USER/stop", "admin", {"production": (name_"Other")}), 409)
        do $$$AssertTrue(json.status.summary[name, "conflict names the running production")
        set status = ..Reply(..Request("GET", "/interop/USER"), 200).result
        do $$$AssertEquals(status.production, name, "wrong stop did not change production")
        do $$$AssertEquals(status.state, "Running", "production still running")
        do $$$AssertEquals(status.items.%Get(0).name, "Demo.Service", "production items")
        do $$$AssertEquals(status.%GetTypeOf("queues"), "array", "queues reported")
        do $$$AssertEquals(status.%GetTypeOf("recentErrors"), "array", "recent errors reported")
        do $$$AssertEquals(status.%GetTypeOf("needsUpdate"), "boolean", "needsUpdate JSON type")
    } catch ex {
        do $$$AssertStatusOK(ex.AsStatus(), "production HTTP checks completed")
    }
    // Cleanup also runs after a transport, JSON, compilation or assertion failure.
    set sc = ..RemoveProduction(name)
    do $$$AssertStatusOK(sc, "fixture production stopped and deleted")
    if $$$ISOK(sc) {
        if hadLast#10 { set ^Ens.Configuration("csp", "LastProduction") = last } else { kill ^Ens.Configuration("csp", "LastProduction") }
    }
}

/// Same production definition as Extension, with a unique class owned by this test.
ClassMethod CreateProduction(name As %String) As %Status
{
    set cls = ##class(%Dictionary.ClassDefinition).%New(name)
    set cls.Super = "Ens.Production", cls.ProcedureBlock = 1
    set x = ##class(%Dictionary.XDataDefinition).%New()
    set x.Name = "ProductionDefinition"
    do x.Data.Write("<Production Name="""_name_""" LogGeneralTraceEvents=""false""><Description>Admin Deck HTTP test production</Description>"
        _"<ActorPoolSize>1</ActorPoolSize><Item Name=""Demo.Service"" ClassName=""EnsLib.Testing.Service"" PoolSize=""0"" Enabled=""true""/></Production>")
    do cls.XDatas.Insert(x)
    set sc = cls.%Save()
    quit:$$$ISERR(sc) sc
    quit $system.OBJ.Compile(name, "ck-d")
}

ClassMethod RemoveProduction(name As %String) As %Status
{
    set sc = ##class(Ens.Director).GetProductionStatus(.running, .state, 2, 1)
    quit:$$$ISERR(sc) sc
    if running = name {
        set sc = ##class(AdminDeck.Interop).Act("USER", "stop", name)
        quit:$$$ISERR(sc) sc
        set sc = ##class(Ens.Director).GetProductionStatus(.running, .state, 2, 1)
        quit:$$$ISERR(sc) sc
        quit:(running'="")||(+state'=2) $$$ERROR($$$GeneralError, "Fixture production did not stop; deletion refused")
    } elseif (running '= "") || (+state '= 2) {
        quit $$$ERROR($$$GeneralError, "Production state changed during test; cleanup refused")
    }
    if ##class(%Dictionary.ClassDefinition).%ExistsId(name) {
        set sc = $system.OBJ.Delete(name, "-d")
        quit:$$$ISERR(sc) sc
    }
    if ##class(Ens.Config.Production).%ExistsId(name) { set sc = ##class(Ens.Config.Production).%DeleteId(name) }
    quit sc
}

}
