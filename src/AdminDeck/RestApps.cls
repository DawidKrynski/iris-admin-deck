/// REST applications of this instance and their routes, for the API explorer (read-only).
/// /api/mgmnt lists them too, but it accepts only password (basic) authentication, never the portal's JWT,
/// and the browser does not keep the password. So the same %REST.API calls run here, in-process.
/// Only the dispatch class of an existing web application is ever read; nothing is executed.
Class AdminDeck.RestApps
{

/// %Admin_Operate (like the rest of the extension) or %Development (the audience of /api/mgmnt).
ClassMethod CanRead() As %Boolean
{
    quit ##class(AdminDeck.Util).CanOperate() || $system.Security.Check("%Development", "USE")
}

/// Web application names are paths: "/" and plain characters, no "..".
ClassMethod ValidApp(app As %String) As %Boolean
{
    quit $match(app, "^/[A-Za-z0-9_%./-]{0,255}$") && (app '[ "..")
}

/// Same list as GET /api/mgmnt/ (v1): [{name, dispatchClass, namespace, resource, swaggerSpec, enabled}].
/// swaggerSpec points to /api/mgmnt/v2/... for spec-first applications, to /api/mgmnt/v1/... otherwise.
ClassMethod List() As %DynamicArray
{
    $$$ThrowOnError(##class(%REST.API).GetAllWebRESTApps(.list))
    $$$ThrowOnError(##class(%REST.API).ListToArray(list, .out))
    quit out
}

/// The entry of List() for one web application, or "". Security.Applications would need %SYS
/// (a <PROTECT> error for %Developer); %REST.API lists what the caller's namespaces allow.
ClassMethod Find(app As %String) As %DynamicObject
{
    set it = ..List().%GetIterator()
    while it.%GetNext(, .row) {
        return:row.name=app row
    }
    quit ""
}

/// {app, namespace, dispatchClass, enabled, specFirst, spec, specError, routes, routesError} for one web
/// application with a dispatch class. A part that cannot be read carries its error instead of being left out.
ClassMethod Describe(app As %String, Output out As %DynamicObject) As %Status
{
    set out = ""
    quit:'..ValidApp(app) $$$ERROR($$$GeneralError, "Invalid web application name")
    set row = ..Find(app)
    quit:row="" $$$ERROR($$$GeneralError, "No REST application "_app_" (unknown, without a dispatch class, or in a namespace you cannot use)")
    set cls = row.dispatchClass, ns = row.namespace
    quit:'##class(AdminDeck.Interop).ValidName(cls) $$$ERROR($$$GeneralError, "Invalid dispatch class name")
    set out = {"app": (app), "namespace": (ns), "dispatchClass": (cls), "spec": null, "routes": null}
    do out.%Set("enabled", ''row.enabled, "boolean")
    new $namespace
    // %-classes live in IRISLIB and are visible from every namespace: switching to %SYS would need its database.
    set nsError = ""
    try {
        set:$extract(cls)'="%" $namespace = ns
    } catch ex {
        set nsError = ex.DisplayString()
    }
    if nsError '= "" {
        do out.%Set("specFirst", 0, "boolean")
        set out.routesError = "Namespace "_ns_" is not available: "_nsError
        quit $$$OK
    }
    if '##class(%Dictionary.CompiledClass).%ExistsId(cls) {
        do out.%Set("specFirst", 0, "boolean")
        set out.routesError = "Class "_cls_" is not compiled in "_ns
        quit $$$OK
    }
    // Spec-first applications (%REST.disp) keep their OpenAPI 2.0 document in <package>.spec.
    set specFirst = $classmethod(cls, "%Extends", "%REST.disp")
    do out.%Set("specFirst", specFirst, "boolean")
    if specFirst {
        try {
            set sc = ##class(%REST.API).GetApplication($piece(cls, ".", 1, *-1), .swagger)
            if $$$ISOK(sc) { set out.spec = swagger } else { set out.specError = $system.Status.GetErrorText(sc) }
        } catch ex { set out.specError = ex.DisplayString() }
    }
    try {
        set routes = []
        set sc = ..UrlMap(cls, "", routes, 0)
        if $$$ISOK(sc) { set out.routes = routes } else { set out.routesError = $system.Status.GetErrorText(sc) }
    } catch ex { set out.routesError = ex.DisplayString() }
    quit $$$OK
}

/// Appends [{method, url, call, class}] of the UrlMap XData of a %CSP.REST class, following
/// <Map Prefix Forward> into the forwarded classes (depth-limited, class names validated).
ClassMethod UrlMap(cls As %String, prefix As %String, routes As %DynamicArray, depth As %Integer) As %Status
{
    quit:depth>5 $$$ERROR($$$GeneralError, "UrlMap forwards nested too deep")
    quit:'##class(AdminDeck.Interop).ValidName(cls) $$$ERROR($$$GeneralError, "Invalid forward class "_cls)
    set xdata = ##class(%Dictionary.CompiledXData).%OpenId(cls_"||UrlMap")
    quit:'$isobject(xdata) $$$ERROR($$$GeneralError, cls_" has no UrlMap")
    set sc = ##class(%XML.TextReader).ParseStream(xdata.Data, .reader)
    quit:$$$ISERR(sc) sc
    while $$$ISOK(sc) && reader.Read() {
        continue:reader.NodeType'="element"
        set name = reader.LocalName
        continue:(name'="Route")&&(name'="Map")
        kill attr
        for i = 1:1:reader.AttributeCount {
            do reader.MoveToAttributeIndex(i)
            set attr(reader.LocalName) = reader.Value
        }
        if name = "Route" {
            // %CSP.REST: a Route without Method answers GET.
            do routes.%Push({"method": ($zconvert($get(attr("Method"), "GET"), "U")), "url": (prefix_$get(attr("Url"))),
                "call": ($get(attr("Call"))), "class": (cls)})
        } else {
            // The Prefix of a Map is a pattern like "/v1" or "/:ns"; the rest of the URL goes to Forward.
            set sc = ..UrlMap($get(attr("Forward")), prefix_$get(attr("Prefix")), routes, depth + 1)
        }
    }
    quit sc
}

}
