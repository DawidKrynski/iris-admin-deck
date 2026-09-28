/// Backup status (what the classic portal shows under System Operation > Backup): the backup
/// definitions (Backup.Task), the Task Manager tasks that run them, and the backup history IRIS records
/// (Backup.Task:History, which also holds external backups registered with Backup.General.ExternalSetHistory).
/// Read-only: nothing here starts, changes or deletes a backup.
Class AdminDeck.Backups
{

/// Task Manager classes that perform a backup (the classic portal offers these as backup task types).
Parameter TASKCLASSES = "%SYS.Task.BackupAllDatabases,%SYS.Task.BackupFullDatabaseList,%SYS.Task.BackupIncrementDatabaseList,%SYS.Task.BackupCumulativeDatabaseList";

/// {definitions:[...], scheduled:[...], history:[...], lastSuccessful:{Full,Incremental,Cumulative,External},
///  lastFull:{recorded, time, description, device}, now}
/// `limit` only shortens the history list; lastSuccessful is taken from the whole history.
/// Throws when a source cannot be read, so callers can tell "no backups" from "could not read".
ClassMethod Summary(limit As %Integer = 200) As %DynamicObject
{
    new $namespace
    set $namespace = "%SYS"
    set history = ..History(limit, .last)
    // $LB(0, message) or $LB(1, date, description, device)
    set full = ##class(Backup.General).GetLastFullBackupInfo(), recorded = +$listget(full, 1)
    set lastFull = {"time": ($select(recorded: $listget(full, 2), 1: "")),
        "description": ($listget(full, $select(recorded: 3, 1: 2))), "device": ($listget(full, 4))}
    do lastFull.%Set("recorded", recorded, "boolean")
    quit {
        "definitions": (..Definitions()),
        "scheduled": (..Scheduled()),
        "history": (history),
        "lastSuccessful": (last),
        "lastFull": (lastFull),
        "now": ($zdatetime($horolog, 3))
    }
}

/// Backup definitions (Backup.Task:List): name, type, device, last run and its status.
ClassMethod Definitions() As %DynamicArray
{
    set out = [], rs = ..Query("Backup.Task:List")
    while ..Next(rs) {
        set name = rs.Get("Name"), task = ##class(Backup.Task).%OpenId(name, 0)
        // The query shortens descriptions to 35 characters; the definition has the full text
        set row = {"name": (name), "type": (rs.Get("Type")), "device": (rs.Get("Device")),
            "description": ($select($isobject(task): task.Description, 1: rs.Get("Description"))),
            "lastRun": (rs.Get("LastRunTime")), "status": (rs.Get("Status")), "statusText": (rs.Get("StatusStr")),
            "lastLogFile": (rs.Get("LastLogFile"))}
        do row.%Set("switchJournal", ''rs.Get("SwitchJournal"), "boolean")
        do row.%Set("system", ''rs.Get("ReadOnly"), "boolean")
        do out.%Push(row)
    }
    quit out
}

/// Task Manager tasks that run a backup, with their schedule and last result.
ClassMethod Scheduled() As %DynamicArray
{
    // LastStarted/LastFinished are 0 until a task has run; the Display* columns are "" then
    set out = [], st = ##class(%SQL.Statement).%New(1)
    set sql = "SELECT ID, Name, TaskClass, Suspended, DisplayStarted AS LastStarted, DisplayFinished AS LastFinished, Status, Error, DisplayNextScheduled FROM %SYS.Task WHERE TaskClass %INLIST ? ORDER BY Name"
    $$$ThrowOnError(st.%Prepare(sql))
    set rs = st.%Execute($listfromstring(..#TASKCLASSES))
    if rs.%SQLCODE < 0 { $$$ThrowStatus($$$ERROR($$$SQLError, rs.%SQLCODE, rs.%Message)) }
    while rs.%Next() {
        set row = {"id": (rs.ID), "name": (rs.Name), "taskClass": (rs.TaskClass),
            "lastStarted": (rs.LastStarted), "lastFinished": (rs.LastFinished), "status": (rs.Status),
            "error": (rs.Error), "nextRun": (rs.DisplayNextScheduled)}
        do row.%Set("suspended", ''rs.Suspended, "boolean")
        do out.%Push(row)
    }
    quit out
}

/// Backup history, newest first (Backup.Task:History), at most `limit` rows:
/// [{type, databases, time, journal, logFile, status, ok, ageDays}] (ageDays: whole days since `time`, null when unparsable)
/// `last` returns the newest successful run of each type over the whole history, however long.
ClassMethod History(limit As %Integer = 200, Output last As %DynamicObject) As %DynamicArray
{
    quit ..Collect(..Query("Backup.Task:History", "", ""), limit, .last)
}

/// Reads history rows (newest first) from `rs`: the first `limit` as JSON, and in `last` the newest
/// successful row of each type among all of them.
ClassMethod Collect(rs As %ResultSet, limit As %Integer, Output last As %DynamicObject) As %DynamicArray
{
    set out = [], last = {}
    while ..Next(rs) {
        set row = ..HistoryRow(rs)
        do:out.%Size()<limit out.%Push(row)
        // History is newest first: the first successful row of a type is the last successful backup
        do:row.ok&&'last.%IsDefined(row.type) last.%Set(row.type, row)
    }
    quit out
}

/// One Backup.Task:History row as JSON.
ClassMethod HistoryRow(rs As %ResultSet) As %DynamicObject [ Private ]
{
    set status = rs.Get("Status"), time = rs.Get("Time"), h = ..ParseTime(time)
    set row = {"type": (..TypeName(rs.Get("Type"))), "databases": (rs.Get("Databases")), "time": (time),
        "journal": (rs.Get("Journal")), "logFile": (rs.Get("LogFile")), "status": (status)}
    do row.%Set("ok", ..Succeeded(status), "boolean")
    do row.%Set("ageDays", $select(h="": "", 1: $horolog - h), $select(h="": "null", 1: "number"))
    quit row
}

/// $horolog date of a history time (ODBC "YYYY-MM-DD hh:mm:ss" or US "MM/DD/YYYY hh:mm:ss"), "" if unparsable.
ClassMethod ParseTime(time As %String) As %String
{
    set h = $zdatetimeh(time, 3, , , , , , , , "")
    set:h="" h = $zdatetimeh(time, 1, , , , , , , , "")
    quit $select(h="": "", 1: +h)
}

/// Normalised backup type: Full, Incremental, Cumulative, External (anything else is kept as reported).
ClassMethod TypeName(type As %String) As %String
{
    set t = $zconvert(type, "L")
    quit $select(t["cumul": "Cumulative", t["incr": "Incremental", t["full": "Full", t["ext": "External", type="": "Unknown", 1: type)
}

/// True for a history status that reports a completed backup (not failed, aborted or with a warning).
ClassMethod Succeeded(status As %String) As %Boolean
{
    set s = $zconvert(status, "L")
    quit:(s["fail")||(s["abort")||(s["error")||(s["warn")||(s["cancel") 0
    quit (s["complet")||(s["success")||(s = "ok")
}

/// Runs a class query; throws on failure.
ClassMethod Query(name As %String, args...) As %ResultSet [ Private ]
{
    set rs = ##class(%ResultSet).%New(name)
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
