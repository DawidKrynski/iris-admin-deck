/// Shared helpers for the extension API.
Class AdminDeck.Util
{

/// Current log files the portal may read. Keys are public identifiers; values are file names
/// in the manager directory. Rotated files (messages.old_*, alerts.old_*) are added by ListLogFiles().
ClassMethod LogFiles() As %DynamicObject
{
    quit {
        "messages": "messages.log",
        "alerts": "alerts.log",
        "monitor": "SystemMonitor.log",
        "journal": "journal.log",
        "startup": "iboot.log"
    }
}

/// Rotated log names accepted as keys (the key is the file name itself). Implements
/// Ideas portal DPI-I-966: browse older messages.log files without shell access to the server.
Parameter ROTATEDPATTERN = "^(messages|alerts)\.old_[A-Za-z0-9_]+$";

/// Resolves a key to a full path, or "" if the key is not an allowed log file.
/// Nothing outside the manager directory and the allow-list is ever opened.
ClassMethod LogPath(key As %String) As %String
{
    set mgr = ##class(%File).ManagerDirectory()
    set name = ..LogFiles().%Get(key)
    if name = "" {
        quit:'$match(key, ..#ROTATEDPATTERN) ""
        set name = key
        quit:'##class(%File).Exists(##class(%File).NormalizeFilename(name, mgr)) ""
    }
    quit ##class(%File).NormalizeFilename(name, mgr)
}

/// [{key,name,exists,size,modified,rotated}] - current logs first, then rotated ones newest first.
ClassMethod ListLogFiles() As %DynamicArray
{
    set out = [], it = ..LogFiles().%GetIterator()
    while it.%GetNext(.key, .name) {
        set path = ..LogPath(key), exists = ##class(%File).Exists(path)
        do out.%Push({"key": (key), "name": (name), "exists": (exists), "rotated": false,
            "size": ($select(exists: ##class(%File).GetFileSize(path), 1: 0)),
            "modified": ($select(exists: $zdatetime(##class(%File).GetFileDateModified(path), 3), 1: ""))})
    }
    set mgr = ##class(%File).ManagerDirectory(), rs = ##class(%File).FileSetFunc(mgr, "*.old_*", "DateModified", 0)
    set rotated = 0
    while rs.%Next() {
        set name = rs.Get("ItemName")
        continue:'$match(name, ..#ROTATEDPATTERN)
        set rotated($increment(rotated)) = {"key": (name), "name": (name), "exists": true, "rotated": true,
            "size": (rs.Get("Size")), "modified": (rs.Get("DateModified"))}
    }
    for i = rotated:-1:1 { do out.%Push(rotated(i)) }
    quit out
}

/// True if the current user holds %Admin_Operate:USE (same privilege the SysAdmin API
/// requires for monitoring/process endpoints).
ClassMethod CanOperate() As %Boolean
{
    quit $system.Security.Check("%Admin_Operate", "USE")
}

}
