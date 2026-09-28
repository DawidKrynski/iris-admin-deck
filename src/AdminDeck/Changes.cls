/// Change log: changes made through Admin Deck, with the outcome of reading them back.
/// Kept in ^AdminDeck("Changes") in the package database, which is journaled on purpose: this is a record.
/// The IRIS security audit stays the authoritative record; this one only covers calls made from the UI.
/// Request bodies are never stored (they may hold passwords or keys), only method and path of each call.
Class AdminDeck.Changes
{

/// Entries kept; the oldest are trimmed beyond this.
Parameter KEEP = 5000;

Parameter MAXCALLS = 10;

Parameter MAXWHAT = 200;

Parameter MAXPATH = 500;

Parameter MAXDETAILS = 500;

/// The outcomes of web/js/verify.js, plus refused (stale edit) and failed (the write itself failed).
Parameter OUTCOMES = "verified,partly-verified,not-reflected,read-failed,unverified,refused,failed";

Parameter METHODS = "POST,PUT,PATCH,DELETE,GET";

/// Validates `body` ({what, calls: [{method, path}], outcome, details}) and stores it for `username`.
/// Returns the stored entry in `entry`. `keep` exists for the tests.
ClassMethod Record(body, username As %String = {$username}, Output entry As %DynamicObject, keep As %Integer = {..#KEEP}) As %Status
{
    set entry = ""
    quit:'$isobject(body)||'body.%IsA("%DynamicObject") ..Invalid("Body must be a JSON object")
    quit:body.%GetTypeOf("what")'="string" ..Invalid("what is required")
    set what = ..Clean(..RedactText(body.what), ..#MAXWHAT)
    quit:what="" ..Invalid("what is required")
    set outcome = body.%Get("outcome")
    quit:(body.%GetTypeOf("outcome")'="string")||'$listfind($listfromstring(..#OUTCOMES), outcome) ..Invalid("outcome must be one of "_..#OUTCOMES)
    set type = body.%GetTypeOf("details")
    quit:'$listfind($listbuild("string", "unassigned", "null"), type) ..Invalid("details must be text")
    set details = ..Clean(..RedactText(body.%Get("details")), ..#MAXDETAILS)
    set type = body.%GetTypeOf("calls")
    quit:'$listfind($listbuild("array", "unassigned", "null"), type) ..Invalid("calls must be an array")
    set calls = []
    if type = "array" {
        // Only the first MAXCALLS; whatever else a call object carries (a body) is dropped here.
        for i = 0:1:$select(body.calls.%Size() > ..#MAXCALLS: ..#MAXCALLS, 1: body.calls.%Size()) - 1 {
            set c = body.calls.%Get(i)
            quit:'$isobject(c)||'c.%IsA("%DynamicObject")
            set method = $zconvert(c.%Get("method"), "U"), path = ..Clean(c.%Get("path"), ..#MAXPATH)
            quit:'$listfind($listfromstring(..#METHODS), method)||($extract(path)'="/")
            do calls.%Push({"method": (method), "path": (..RedactQuery(path))})
        }
        quit:calls.%Size()<$select(body.calls.%Size() > ..#MAXCALLS: ..#MAXCALLS, 1: body.calls.%Size()) ..Invalid("each call needs a method and a path starting with /")
    }
    set time = $zdatetime($horolog, 3)
    lock +^AdminDeck("Changes"):5
    quit:'$test $$$ERROR($$$GeneralError, "Change log is busy")
    set id = $increment(^AdminDeck("Changes", "last"))
    set ^AdminDeck("Changes", "e", id) = $listbuild(time, username, what, outcome, details, calls.%ToJSON())
    // A count, not last - first: trimming then stays right even if an entry was removed by hand.
    set count = $increment(^AdminDeck("Changes", "count"))
    while count > keep {
        set oldest = $order(^AdminDeck("Changes", "e", ""))
        quit:oldest=""
        kill ^AdminDeck("Changes", "e", oldest)
        set count = $increment(^AdminDeck("Changes", "count"), -1)
    }
    lock -^AdminDeck("Changes")
    set entry = ..Entry(id)
    quit $$$OK
}

/// Newest first, at most `limit`. `user` matches the username exactly (any case); `q` is a substring of
/// the user, what, outcome, details or a call path (any case).
ClassMethod List(limit As %Integer = 200, user As %String = "", q As %String = "") As %DynamicArray
{
    set out = [], id = "", user = $zconvert(user, "L"), q = $zconvert(q, "L")
    for {
        set id = $order(^AdminDeck("Changes", "e", id), -1, row)
        quit:(id="")||(out.%Size()>=limit)
        continue:(user'="")&&($zconvert($list(row, 2), "L")'=user)
        continue:(q'="")&&'($zconvert($listtostring($list(row, 2, 6), " "), "L")[q)
        do out.%Push(..Entry(id))
    }
    quit out
}

ClassMethod Entry(id As %Integer) As %DynamicObject
{
    set row = $get(^AdminDeck("Changes", "e", id))
    quit:row="" ""
    quit {"id": (+id), "time": ($list(row, 1)), "user": ($list(row, 2)), "what": ($list(row, 3)),
        "outcome": ($list(row, 4)), "details": ($list(row, 5)), "calls": ({}.%FromJSON($list(row, 6)))}
}

/// Single-line text without control characters, at most `max` characters.
ClassMethod Clean(value, max As %Integer) As %String
{
    quit $extract($zstrip($zstrip($translate(value, $char(9, 10, 13), "   "), "*C"), "<>W"), 1, max)
}

/// Replaces query-string values whose names look like password, secret or token with ***.
ClassMethod RedactQuery(path As %String) As %String
{
    quit ##class(%Regex.Matcher).%New("(?i)([?&][^=&#]*(password|secret|token)[^=&#]*=)[^&#]*", path).ReplaceAll("$1***")
}

/// Free text (what, details): the value of any name=value pair whose name looks like password, secret or
/// token is replaced with ***, wherever it stands (a title such as "POST /x?token=..." or an error message).
ClassMethod RedactText(text As %String) As %String
{
    quit:text="" ""
    quit ##class(%Regex.Matcher).%New("(?i)([^\s?&=;,""']*(password|secret|token)[^\s?&=;,""']*=)[^&#\s""',;]*", text).ReplaceAll("$1***")
}

ClassMethod Invalid(message As %String) As %Status [ Private ]
{
    quit $$$ERROR($$$GeneralError, message)
}

}
