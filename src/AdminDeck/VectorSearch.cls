/// "Find similar incidents": IRIS Vector Search over log entries.
Class AdminDeck.VectorSearch
{

/// Rebuilds the index for one allow-listed log file. Returns number of indexed entries.
ClassMethod Reindex(fileKey As %String, Output count As %Integer) As %Status
{
    set count = 0
    set path = ##class(AdminDeck.Util).LogPath(fileKey)
    quit:path="" $$$ERROR($$$GeneralError, "Unknown log file: "_fileKey)
    // Delete + insert in one transaction: a failure keeps the previous index.
    set sc = $$$OK
    try {
        TSTART
        &sql(DELETE FROM AdminDeck_Data.LogLine WHERE File = :fileKey)
        // Embedded SQL reports errors in SQLCODE (100 = nothing to delete), it does not throw
        throw:SQLCODE<0 ##class(%Exception.SQL).CreateFromSQLCODE(SQLCODE, %msg)
        set count = ..PyIndex(fileKey, path)
        TCOMMIT
    } catch ex {
        TROLLBACK:$tlevel 1
        set sc = ex.AsStatus(), count = 0
    }
    quit sc
}

ClassMethod PyIndex(fileKey As %String, path As %String) As %Integer [ Language = python ]
{
import iris
from admindeck import bridge
stmt = iris.sql.prepare(
    "INSERT INTO AdminDeck_Data.LogLine (File, LineNo, Ts, Pid, Severity, Source, Message, Embedding) "
    "VALUES (?, ?, ?, ?, ?, ?, ?, TO_VECTOR(?, DOUBLE))")
n = 0
for row in bridge.index_entries(path):
    stmt.execute(fileKey, *row)
    n += 1
return n
}

/// Returns a %DynamicArray of the k entries most similar to text (cosine similarity, descending).
ClassMethod Similar(text As %String, fileKey As %String = "", k As %Integer = 10, minSeverity As %Integer = 0) As %DynamicArray
{
    set vec = ..Embed(text), out = []
    set sql = "SELECT TOP ? ID, File, LineNo, Ts, Pid, Severity, Source, Message, "_
              "VECTOR_COSINE(Embedding, TO_VECTOR(?, DOUBLE)) AS Score "_
              "FROM AdminDeck_Data.LogLine WHERE Severity >= ?"_$select(fileKey'="":" AND File = ?", 1:"")_
              " ORDER BY Score DESC"
    if fileKey'="" { set rs = ##class(%SQL.Statement).%ExecDirect(, sql, k, vec, minSeverity, fileKey) }
    else { set rs = ##class(%SQL.Statement).%ExecDirect(, sql, k, vec, minSeverity) }
    throw:rs.%SQLCODE<0 ##class(%Exception.SQL).CreateFromSQLCODE(rs.%SQLCODE, rs.%Message)
    while rs.%Next() {
        do out.%Push({"id": (rs.ID), "file": (rs.File), "line": (rs.LineNo), "ts": (rs.Ts), "pid": (rs.Pid),
            "severity": (rs.Severity), "source": (rs.Source), "message": (rs.Message), "score": ($fnumber(rs.Score, "", 4))})
    }
    quit out
}

/// Index status per file: {"messages": {"count": n}, ...}
ClassMethod Status() As %DynamicObject
{
    set out = {}
    // %EXACT: GROUP BY would otherwise return the SQLUPPER-collated value ("MESSAGES")
    set rs = ##class(%SQL.Statement).%ExecDirect(, "SELECT %EXACT(File) AS File, COUNT(*) AS Cnt FROM AdminDeck_Data.LogLine GROUP BY %EXACT(File)")
    while rs.%Next() { do out.%Set(rs.File, {"count": (rs.Cnt)}) }
    quit out
}

ClassMethod Embed(text As %String) As %String [ Language = python ]
{
from admindeck import bridge
return bridge.vector(text)
}

}
