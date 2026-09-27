/// Structured access to IRIS log files, implemented with Embedded Python (see python/admindeck).
Class AdminDeck.Logs
{

/// JSON: {size,total,counts,sources,entries:[{line,ts,pid,severity,level,source,message}]}, newest first.
ClassMethod Query(path As %String, minSeverity As %Integer = 0, text As %String = "", limit As %Integer = 200, offset As %Integer = 0, source As %String = "") As %String [ Language = python ]
{
from admindeck import bridge
return bridge.logs(path, minSeverity, text, limit, offset, source)
}

/// JSON: {size,distinct,patterns:[{source,pattern,count,maxSeverity,first,last,example}]}
ClassMethod Insights(path As %String, minSeverity As %Integer = 1, top As %Integer = 15) As %String [ Language = python ]
{
from admindeck import bridge
return bridge.insights(path, minSeverity, top)
}

}
