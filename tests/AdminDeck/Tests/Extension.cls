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

}
