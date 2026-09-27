/// Task Manager task: refreshes the similar-incident vector index for IRIS log files.
Class AdminDeck.Task.ReindexLogs Extends %SYS.Task.Definition
{

Parameter TaskName = "Admin Deck: reindex logs";

/// Comma-separated log keys (see AdminDeck.Util:LogFiles).
Property Files As %String [ InitialExpression = "messages,alerts" ];

Method OnTask() As %Status
{
    set sc = $$$OK
    for i = 1:1:$length(..Files, ",") {
        set key = $zstrip($piece(..Files, ",", i), "<>W")
        continue:key=""
        continue:'##class(%File).Exists(##class(AdminDeck.Util).LogPath(key))
        set sc = $$$ADDSC(sc, ##class(AdminDeck.VectorSearch).Reindex(key, .count))
    }
    quit sc
}

}
