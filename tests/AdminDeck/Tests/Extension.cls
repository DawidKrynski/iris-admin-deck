/// Unit tests for the Admin Deck extension (run: zpm "iris-admin-deck test").
Class AdminDeck.Tests.Extension Extends %UnitTest.TestCase
{

Method TestLogPathAllowList()
{
    do $$$AssertNotEquals(##class(AdminDeck.Util).LogPath("messages"), "", "messages.log is allowed")
    do $$$AssertEquals(##class(AdminDeck.Util).LogPath("../../etc/passwd"), "", "path traversal rejected")
    do $$$AssertEquals(##class(AdminDeck.Util).LogPath("iris.cpf"), "", "files outside the allow-list rejected")
    do $$$AssertEquals(##class(AdminDeck.Util).LogPath("messages.old_../../x"), "", "malformed rotated name rejected")
}

Method TestLogQuery()
{
    set res = {}.%FromJSON(##class(AdminDeck.Logs).Query(##class(AdminDeck.Util).LogPath("messages"), 0, "", 5))
    do $$$AssertTrue(res.total > 0, "messages.log has entries")
    do $$$AssertTrue(res.entries.%Size() <= 5, "limit respected")
    do $$$AssertNotEquals(res.entries.%Get(0).ts, "", "timestamp parsed")
}

Method TestEmbeddingDeterministic()
{
    set a = ##class(AdminDeck.VectorSearch).Embed("Error opening file /tmp/a.txt: 13")
    set b = ##class(AdminDeck.VectorSearch).Embed("Error opening file /tmp/a.txt: 13")
    do $$$AssertEquals(a, b, "same text gives same vector")
    do $$$AssertEquals($length(a, ","), 256, "256 dimensions")
}

Method TestVectorSearch()
{
    do $$$AssertStatusOK(##class(AdminDeck.VectorSearch).Reindex("messages", .count))
    do $$$AssertTrue(count > 0, "indexed "_count_" entries")
    set hits = ##class(AdminDeck.VectorSearch).Similar("Mounted database read-write", "messages", 3)
    do $$$AssertEquals(hits.%Size(), 3, "top-k returned")
    do $$$AssertTrue(hits.%Get(0).score >= hits.%Get(2).score, "sorted by similarity")
}

Method TestOSSnapshot()
{
    set os = {}.%FromJSON(##class(AdminDeck.OS).Snapshot())
    do $$$AssertTrue(os.cpu.cores > 0, "cpu cores")
    do $$$AssertTrue(os.memory.total > 0, "memory total")
    do $$$AssertTrue(os.disks.%Size() > 0, "at least one disk")
}

Method TestApplicationErrors()
{
    // Record a real application error through ^%ETN (it stores the text passed in), then find it.
    set marker = "Admin Deck unit test "_$random(1000000000)
    try { set x = 1 / 0 } catch ex { do LOG^%ETN(marker) }
    set list = ##class(AdminDeck.AppErrors).List(1, 5000), found = 0
    set it = list.%GetIterator()
    while it.%GetNext(, .e) {
        if (e.namespace = $namespace) && (e.message [ marker) { set found = 1 }
    }
    do $$$AssertTrue(found, "logged error is listed")
    if list.%Size() > 1 {
        do $$$AssertTrue('(list.%Get(1).ts ]] list.%Get(0).ts), "newest first")
    }
    set two = ##class(AdminDeck.AppErrors).List(1, 2)
    do $$$AssertTrue(two.%Size() <= 2, "limit respected")
}

Method TestHideHostDetails()
{
    set saved = $get(^AdminDeck("Settings", "HideHostDetails"))
    set ^AdminDeck("Settings", "HideHostDetails") = 1
    set os = {}.%FromJSON(##class(AdminDeck.OS).Snapshot())
    do $$$AssertTrue('os.%IsDefined("kernel") && 'os.%IsDefined("hostname") && 'os.%IsDefined("uptimeSec"), "host details hidden")
    do $$$AssertTrue(os.memory.total > 0, "usage numbers kept")
    set ^AdminDeck("Settings", "HideHostDetails") = saved
}

Method TestMetricsHistory()
{
    set h = ##class(AdminDeck.Metrics).History()
    do $$$AssertEquals(h.interval, 5, "sampling interval reported")
    hang h.interval * 2 + 1
    set points = ##class(AdminDeck.Metrics).History().points
    do $$$AssertTrue(points.%Size() > 0, "the sampler is recording")
    set last = points.%Get(points.%Size() - 1)
    do $$$AssertTrue((last.%Get(1) >= 0) && (last.%Get(2) >= 0) && (last.%Get(2) <= 100), "rates and CPU % in range")
    do $$$AssertEquals(last.%Size(), h.fields.%Size() + 1, "one value per field after the time")
    do $$$AssertTrue(last.%Get(8) >= -1 && (last.%Get(8) <= 2), "system state reported")
}

Method TestBackupSummary()
{
    set b = ##class(AdminDeck.Backups).Summary(20)
    do $$$AssertEquals($namespace, "USER", "namespace restored after reading %SYS")
    // IRIS ships four backup definitions (FullAllDatabases, FullDBList, IncrementalDBList, CumuIncrDBList)
    do $$$AssertTrue(b.definitions.%Size() >= 4, "backup definitions listed")
    set found = 0, it = b.definitions.%GetIterator()
    while it.%GetNext(, .d) { set:d.name="FullAllDatabases" found = 1 }
    do $$$AssertTrue(found, "FullAllDatabases definition present")
    do $$$AssertTrue(b.history.%Size() <= 20, "history limit respected")
    do $$$AssertTrue($isobject(b.scheduled) && $isobject(b.lastSuccessful), "scheduled tasks and last successful backups reported")
    do $$$AssertEquals(b.lastFull.%GetTypeOf("recorded"), "boolean", "last full backup flag is a boolean")
    // lastSuccessful holds only successful runs, and the newest one of each type
    set it = b.lastSuccessful.%GetIterator()
    while it.%GetNext(.type, .row) { do $$$AssertTrue(row.ok && (row.type = type), "last "_type_" backup succeeded") }
    // The display limit never changes which backups count as the last successful ones
    do $$$AssertEquals(##class(AdminDeck.Backups).Summary(1).lastSuccessful.%ToJSON(), ##class(AdminDeck.Backups).Summary(2000).lastSuccessful.%ToJSON(), "lastSuccessful independent of the limit")
}

/// lastSuccessful comes from the whole history, also from rows beyond the display limit.
Method TestBackupLastSuccessfulBeyondLimit()
{
    // History rows, newest first: two failed runs, then a successful incremental and full backup
    set sql = "SELECT Type, ""Time"", Status, Databases, Journal, LogFile FROM ("
        _"SELECT 1 AS Seq, 'Full' AS Type, '2026-09-27 01:00:00' AS ""Time"", 'Failed' AS Status, '' AS Databases, '' AS Journal, '' AS LogFile"
        _" UNION ALL SELECT 2, 'Full', '2026-09-26 01:00:00', 'Aborted', '', '', ''"
        _" UNION ALL SELECT 3, 'Incremental', '2026-09-25 01:00:00', 'Completed', '', '', ''"
        _" UNION ALL SELECT 4, 'Full', '2026-09-20 01:00:00', 'Completed', '', '', ''"
        _" UNION ALL SELECT 5, 'Full', '2026-09-13 01:00:00', 'Completed', '', '', '') ORDER BY Seq"
    set rs = ##class(%ResultSet).%New("%DynamicQuery:SQL")
    do $$$AssertStatusOK(rs.Prepare(sql), "fake history prepared")
    do $$$AssertStatusOK(rs.Execute(), "fake history read")
    set page = ##class(AdminDeck.Backups).Collect(rs, 2, .last)
    do $$$AssertEquals(page.%Size(), 2, "display limit applied")
    do $$$AssertTrue('page.%Get(0).ok && 'page.%Get(1).ok, "the page itself holds only failed runs")
    do $$$AssertEquals(last.Full.time, "2026-09-20 01:00:00", "newest successful full backup found beyond the limit")
    do $$$AssertEquals(last.Incremental.time, "2026-09-25 01:00:00", "newest successful incremental backup found beyond the limit")
    do $$$AssertTrue('last.%IsDefined("Cumulative"), "no cumulative backup invented")
}

Method TestBackupClassification()
{
    set b = "AdminDeck.Backups"
    do $$$AssertTrue($classmethod(b, "Succeeded", "Completed"), "Completed is a success")
    do $$$AssertTrue('$classmethod(b, "Succeeded", "Failed"), "Failed is not")
    do $$$AssertTrue('$classmethod(b, "Succeeded", "Completed with warnings"), "a warning is not a clean success")
    do $$$AssertTrue('$classmethod(b, "Succeeded", "Aborted"), "Aborted is not")
    do $$$AssertTrue('$classmethod(b, "Succeeded", ""), "no status is not")
    do $$$AssertEquals($classmethod(b, "TypeName", "Cumulative Incremental"), "Cumulative", "cumulative")
    do $$$AssertEquals($classmethod(b, "TypeName", "Incremental"), "Incremental", "incremental")
    do $$$AssertEquals($classmethod(b, "TypeName", "Full"), "Full", "full")
    do $$$AssertEquals($classmethod(b, "TypeName", "External"), "External", "external")
    do $$$AssertEquals($classmethod(b, "ParseTime", "2026-09-20 01:00:00"), $zdateh("2026-09-20", 3), "ODBC time")
    do $$$AssertEquals($classmethod(b, "ParseTime", "09/20/2026 01:00:00"), $zdateh("2026-09-20", 3), "US time")
    do $$$AssertEquals($classmethod(b, "ParseTime", "junk"), "", "unparsable time")
}

/// Change log tests run on an empty log; the real one is set aside and put back afterwards.
Method TestChangesStore()
{
    merge saved = ^AdminDeck("Changes")
    kill ^AdminDeck("Changes")
    try {
        set body = {"what": "Web application /csp/zztest saved", "outcome": "verified", "details": "",
            "calls": [{"method": "put", "path": "/api/admin/v2/web-app?name=%2Fcsp%2Fzztest&Password=p", "body": {"Password": "secret"}}],
            "user": "Someone Else"}
        do $$$AssertStatusOK(##class(AdminDeck.Changes).Record(body, "zzTester", .entry), "stored")
        do $$$AssertEquals(entry.user, "zzTester", "user is the caller, not taken from the body")
        do $$$AssertTrue($match(entry.time, "\d{4}-\d\d-\d\d \d\d:\d\d:\d\d"), "server timestamp")
        do $$$AssertEquals(entry.calls.%Get(0).method, "PUT", "method normalised")
        do $$$AssertEquals(entry.calls.%Get(0).path, "/api/admin/v2/web-app?name=%2Fcsp%2Fzztest&Password=***", "secret query value redacted")
        do $$$AssertTrue('entry.calls.%Get(0).%IsDefined("body"), "request body not stored")
        do $$$AssertTrue($get(^AdminDeck("Changes", "e", entry.id))'["secret", "body text not in the global")
        do $$$AssertStatusOK(##class(AdminDeck.Changes).Record({"what": "POST /custom/update?token=zzT0k&n=1", "outcome": "failed", "details": "sent ClientSecret=zzS3c, password=zzP4ss"}, "zzTester", .masked), "free text stored")
        do $$$AssertEquals(masked.what, "POST /custom/update?token=***&n=1", "token value in what masked")
        do $$$AssertEquals(masked.details, "sent ClientSecret=***, password=***", "secret values in details masked")
        set row = $get(^AdminDeck("Changes", "e", masked.id))
        do $$$AssertTrue((row'["zzT0k")&&(row'["zzS3c")&&(row'["zzP4ss"), "no secret value in the global")
        kill ^AdminDeck("Changes", "e", masked.id)
        set ^AdminDeck("Changes", "count") = ^AdminDeck("Changes", "count") - 1
        do $$$AssertStatusOK(##class(AdminDeck.Changes).Record({"what": "Task saved", "outcome": "refused", "details": "Description"}, "other"), "second entry, no calls")
        set list = ##class(AdminDeck.Changes).List(10)
        do $$$AssertEquals(list.%Size(), 2, "both listed")
        do $$$AssertEquals(list.%Get(0).what, "Task saved", "newest first")
        do $$$AssertEquals(##class(AdminDeck.Changes).List(10, "ZZTESTER").%Size(), 1, "filter by user, any case")
        do $$$AssertEquals(##class(AdminDeck.Changes).List(10, "", "CSP/ZZ").%Get(0).user, "zzTester", "search what and paths")
        do $$$AssertEquals(##class(AdminDeck.Changes).List(1).%Size(), 1, "limit respected")
    } catch ex {
        do $$$AssertStatusOK(ex.AsStatus(), "no error")
    }
    kill ^AdminDeck("Changes")
    merge ^AdminDeck("Changes") = saved
}

Method TestChangesValidation()
{
    merge saved = ^AdminDeck("Changes")
    kill ^AdminDeck("Changes")
    set c = "AdminDeck.Changes"
    do $$$AssertStatusNotOK($classmethod(c, "Record", [], "u"), "array body refused")
    do $$$AssertStatusNotOK($classmethod(c, "Record", {"outcome": "verified"}, "u"), "what required")
    do $$$AssertStatusNotOK($classmethod(c, "Record", {"what": "  ", "outcome": "verified"}, "u"), "blank what refused")
    do $$$AssertStatusNotOK($classmethod(c, "Record", {"what": "x", "outcome": "fine"}, "u"), "unknown outcome refused")
    do $$$AssertStatusNotOK($classmethod(c, "Record", {"what": "x", "outcome": "failed", "details": {"a": 1}}, "u"), "details must be text")
    do $$$AssertStatusNotOK($classmethod(c, "Record", {"what": "x", "outcome": "failed", "calls": "PUT /x"}, "u"), "calls must be an array")
    do $$$AssertStatusNotOK($classmethod(c, "Record", {"what": "x", "outcome": "failed", "calls": [{"method": "PUT", "path": "x"}]}, "u"), "path must start with /")
    do $$$AssertStatusNotOK($classmethod(c, "Record", {"what": "x", "outcome": "failed", "calls": [{"method": "EVIL", "path": "/x"}]}, "u"), "unknown method refused")
    do $$$AssertEquals($order(^AdminDeck("Changes", "e", "")), "", "nothing stored for invalid input")
    // Sizes are capped, not refused: a change is never lost for a long message
    set calls = []
    for i = 1:1:15 { do calls.%Push({"method": "DELETE", "path": ("/x/"_i)}) }
    set long = {"what": ($translate($justify("", 300), " ", "w")), "outcome": "failed",
        "details": ("line1"_$char(10)_$translate($justify("", 900), " ", "d")), "calls": (calls)}
    do $$$AssertStatusOK($classmethod(c, "Record", long, "u", .entry), "long entry stored")
    do $$$AssertEquals($length(entry.what), 200, "what capped")
    do $$$AssertEquals($length(entry.details), 500, "details capped")
    do $$$AssertTrue(entry.details'[$char(10), "control characters removed")
    do $$$AssertEquals(entry.calls.%Size(), 10, "at most 10 calls")
    kill ^AdminDeck("Changes")
    merge ^AdminDeck("Changes") = saved
}

Method TestChangesTrim()
{
    merge saved = ^AdminDeck("Changes")
    kill ^AdminDeck("Changes")
    do $$$AssertEquals(##class(AdminDeck.Changes).#KEEP, 5000, "5000 entries kept")
    for i = 1:1:7 { do ##class(AdminDeck.Changes).Record({"what": ("change "_i), "outcome": "verified"}, "u", , 5) }
    set list = ##class(AdminDeck.Changes).List(100)
    do $$$AssertEquals(list.%Size(), 5, "trimmed to the limit")
    do $$$AssertEquals(list.%Get(0).what, "change 7", "newest kept")
    do $$$AssertEquals(list.%Get(4).what, "change 3", "oldest trimmed first")
    do $$$AssertEquals(^AdminDeck("Changes", "count"), 5, "count follows the trim")
    kill ^AdminDeck("Changes")
    merge ^AdminDeck("Changes") = saved
}

/// Minimal production created by the Interoperability test and removed again by it.
Parameter DEMOPRODUCTION = "AdminDeck.Tests.zzDemoProduction";

Method TestInteropValidation()
{
    set i = "AdminDeck.Interop"
    do $$$AssertTrue($classmethod(i, "ValidName", "My.Pkg.Production"), "class name accepted")
    do $$$AssertTrue('$classmethod(i, "ValidName", "My.Pkg;kill ^x"), "injection refused")
    do $$$AssertTrue('$classmethod(i, "ValidName", ""), "empty name refused")
    do $$$AssertTrue('$classmethod(i, "ValidNamespace", "../USER"), "odd namespace refused")
    do $$$AssertStatusNotOK($classmethod(i, "CheckNamespace", "ZZNOSUCHNAMESPACE"), "unknown namespace refused")
    do $$$AssertStatusNotOK($classmethod(i, "CheckNamespace", "%SYS"), "%SYS has no Interoperability")
    do $$$AssertEquals($classmethod(i, "StateName", 1), "Running", "state 1")
    do $$$AssertEquals($classmethod(i, "StateName", 4), "Troubled", "state 4")
    do $$$AssertStatusNotOK($classmethod(i, "Act", $namespace, "delete", ""), "unknown action refused")
    set list = ##class(AdminDeck.Interop).Namespaces(), sys = 0
    set it = list.%GetIterator()
    while it.%GetNext(, .row) {
        do $$$AssertTrue($extract(row.namespace)'="^", "no implicit namespaces: "_row.namespace)
        set:row.namespace="%SYS" sys = 1
    }
    do $$$AssertTrue(sys, "%SYS listed")
    set overview = ##class(AdminDeck.Interop).Overview(), it = overview.namespaces.%GetIterator()
    do $$$AssertEquals(overview.%GetTypeOf("canRun"), "boolean", "canRun is a boolean")
    while it.%GetNext(, .row) {
        continue:'row.enabled
        do $$$AssertTrue(row.%IsDefined("state") || row.%IsDefined("error"), row.namespace_": state or error reported")
        do:row.%IsDefined("state") $$$AssertEquals(row.%GetTypeOf("needsUpdate"), "boolean", row.namespace_": needsUpdate stays a boolean")
    }
}

/// Start, update and stop a throw-away production through AdminDeck.Interop.Act, reading the state back each time.
/// Skipped when this namespace has no Interoperability or already runs another production.
Method TestInteropProductionLifecycle()
{
    set ns = $namespace, name = ..#DEMOPRODUCTION
    if '##class(%EnsembleMgr).IsEnsembleNamespace(ns) {
        do $$$LogMessage("Interoperability is not enabled in "_ns_": lifecycle test skipped")
        quit
    }
    do ##class(Ens.Director).GetProductionStatus(.running, .state, 2, 1)
    if (state = 1) && (running '= name) {
        do $$$LogMessage("Production "_running_" is running in "_ns_": lifecycle test skipped")
        quit
    }
    // Starting a production makes it the namespace's "last production": restored at the end
    set hadLast = $data(^Ens.Configuration("csp", "LastProduction"), last)
    do $$$AssertStatusOK(..CreateDemoProduction(), "demo production compiled")
    set sc = ##class(AdminDeck.Interop).Act(ns, "start", name, .result)
    do $$$AssertStatusOK(sc, "start")
    do $$$AssertEquals($select($isobject(result): result.state, 1: ""), "Running", "read back: running")
    set status = ##class(AdminDeck.Interop).Status(ns, 1)
    do $$$AssertEquals(status.production, name, "status names the production")
    do $$$AssertEquals(status.items.%Get(0).name, "Demo.Service", "items listed")
    do $$$AssertTrue($isobject(status.queues) && $isobject(status.recentErrors), "queues and errors reported")
    do $$$AssertStatusOK(##class(AdminDeck.Interop).Act(ns, "update", name, .result), "update")
    do $$$AssertEquals(result.needsUpdate, 0, "read back: nothing left to update")
    // Stop / update / recover act only on the production the caller expects to be current
    set sc = ##class(AdminDeck.Interop).Act(ns, "stop", "AdminDeck.Tests.zzOtherProduction", .result, .conflict)
    do $$$AssertStatusNotOK(sc, "stop of another production refused")
    do $$$AssertTrue(conflict, "refusal reported as a conflict")
    do $$$AssertTrue($system.Status.GetErrorText(sc)[name, "the message names the production that runs")
    do $$$AssertStatusNotOK(##class(AdminDeck.Interop).Act(ns, "recover", "AdminDeck.Tests.zzOtherProduction", .result, .conflict), "recover of another production refused")
    do $$$AssertStatusNotOK(##class(AdminDeck.Interop).Act(ns, "stop", "", .result), "stop without a production name refused")
    do ##class(Ens.Director).GetProductionStatus(.running, .state, 2, 1)
    do $$$AssertEquals(+state, 1, "still running after the refusals")
    do $$$AssertStatusOK(##class(AdminDeck.Interop).Act(ns, "stop", name, .result, .conflict), "stop")
    do $$$AssertTrue('conflict, "no conflict for the expected production")
    do $$$AssertEquals($select($isobject(result): result.state, 1: ""), "Stopped", "read back: stopped")
    do $$$AssertStatusNotOK(##class(AdminDeck.Interop).Act(ns, "stop", name, .result, .conflict), "stop when nothing runs refused")
    do $$$AssertStatusNotOK(##class(AdminDeck.Interop).Act(ns, "start", "AdminDeck.Tests.zzNoSuchProduction", .result), "missing class refused")
    do $$$AssertStatusNotOK(##class(AdminDeck.Interop).Act(ns, "start", "AdminDeck.Util", .result), "non-production class refused")
    do ..DeleteDemoProduction()
    if hadLast#10 { set ^Ens.Configuration("csp", "LastProduction") = last } else { kill ^Ens.Configuration("csp", "LastProduction") }
}

ClassMethod CreateDemoProduction() As %Status
{
    set name = ..#DEMOPRODUCTION
    quit:##class(%Dictionary.CompiledClass).%ExistsId(name) $$$OK
    set cls = ##class(%Dictionary.ClassDefinition).%New(name)
    set cls.Super = "Ens.Production", cls.ProcedureBlock = 1
    set x = ##class(%Dictionary.XDataDefinition).%New()
    set x.Name = "ProductionDefinition"
    do x.Data.Write("<Production Name="""_name_""" LogGeneralTraceEvents=""false""><Description>Admin Deck test production</Description>"
        _"<ActorPoolSize>1</ActorPoolSize><Item Name=""Demo.Service"" ClassName=""EnsLib.Testing.Service"" PoolSize=""0"" Enabled=""true""/></Production>")
    do cls.XDatas.Insert(x)
    set sc = cls.%Save()
    quit:$$$ISERR(sc) sc
    quit $system.OBJ.Compile(name, "ck-d")
}

ClassMethod DeleteDemoProduction()
{
    set name = ..#DEMOPRODUCTION
    do $system.OBJ.Delete(name, "-d")
    do ##class(Ens.Config.Production).%DeleteId(name)
}

}
