// Pure helpers of the explorer tab "REST APIs on this instance" (no DOM, no API): the list of REST
// applications, their routes from an OpenAPI spec or a %CSP.REST UrlMap, path filling and the
// response as plain text. Tested in tests/js.

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/**
 * REST applications from GET /api/admin/v2/web-apps (rows with a DispatchClass) merged with the list of
 * the extension (the same list as GET /api/mgmnt/). `specFirst`: /api/mgmnt serves the spec of a
 * spec-first (%REST.disp) application under /api/mgmnt/v2/, the generated one of the others under /v1/.
 */
export function mergeApps(webApps, restApps) {
  const byName = new Map();
  for (const a of webApps || []) {
    if (!a || !a.DispatchClass) continue;
    byName.set(a.Name, {
      name: a.Name,
      namespace: a.Namespace ?? a.NameSpace ?? '',
      dispatchClass: a.DispatchClass,
      enabled: a.Enabled !== false && a.Enabled !== 0,
      specFirst: false,
      listed: false,
    });
  }
  for (const r of restApps || []) {
    if (!r || !r.name) continue;
    const known = byName.get(r.name) || {
      name: r.name,
      namespace: r.namespace || '',
      dispatchClass: r.dispatchClass || '',
      enabled: r.enabled !== false && r.enabled !== 0,
    };
    byName.set(r.name, { ...known, specFirst: /\/api\/mgmnt\/v2\//.test(r.swaggerSpec || ''), listed: true });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "/logs/:file" -> "/logs/{file}". %CSP.REST names a path parameter with a colon. */
export function urlMapPath(url) {
  return String(url || '').replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

/** Names of the {placeholders} of a path template, in order. */
export function pathParams(template) {
  return [...String(template || '').matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]);
}

/** Fills the {placeholders} with URL-encoded values; throws when one is left empty. */
export function fillPath(template, values = {}) {
  return String(template).replace(/\{([^{}]+)\}/g, (_, name) => {
    const value = String(values[name] ?? '').trim();
    if (!value) throw new Error(`${name} is required.`);
    return encodeURIComponent(value);
  });
}

/** A UrlMap Url is a regular expression: "/(.*)" or "/v1/[^/]+" cannot be sent until edited into a real path. */
export function isPattern(path) {
  return /[()*+?[\]|^$\\]/.test(String(path || ''));
}

const sortRoutes = (routes) =>
  routes.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || METHODS.indexOf(a.method.toLowerCase()) - METHODS.indexOf(b.method.toLowerCase()),
  );

/** Routes of a %CSP.REST UrlMap as the extension returns them: [{method, url, call, class}]. */
export function routesFromUrlMap(routes) {
  return sortRoutes(
    (routes || []).map((r) => {
      const path = urlMapPath(r.url);
      return {
        method: String(r.method || 'GET').toUpperCase(),
        path,
        summary: r.call ? `${r.class ? `${r.class}:` : ''}${r.call}` : '',
        description: '',
        params: pathParams(path).map((name) => ({ name, in: 'path', required: true, description: '' })),
        body: /^(POST|PUT|PATCH)$/i.test(r.method || ''),
      };
    }),
  );
}

// Local $ref only ("#/parameters/id"), which is all %REST specs use.
function deref(spec, item, depth = 0) {
  if (!item || !item.$ref || depth > 8) return item;
  const target = item.$ref
    .replace(/^#\//, '')
    .split('/')
    .reduce((obj, key) => obj?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
  return deref(spec, target, depth + 1);
}

/**
 * Routes of an OpenAPI document: 2.0 (what %REST.API returns for spec-first applications) or 3.x.
 * Path and query parameters become fields; a body parameter, formData or requestBody means a body.
 */
export function routesFromSpec(spec) {
  const out = [];
  for (const [path, item] of Object.entries(spec?.paths || {})) {
    for (const method of METHODS) {
      const op = item?.[method];
      if (!op) continue;
      const all = [...(item.parameters || []), ...(op.parameters || [])]
        .map((p) => deref(spec, p))
        .filter((p) => p && p.name);
      // An operation parameter overrides a path-level one with the same name and location.
      const params = [...new Map(all.map((p) => [`${p.in}:${p.name}`, p])).values()];
      out.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary || op.operationId || '',
        description: op.description || '',
        params: params
          .filter((p) => p.in === 'path' || p.in === 'query')
          .map((p) => ({
            name: p.name,
            in: p.in,
            required: p.in === 'path' || !!p.required,
            description: p.description || '',
          })),
        body: !!op.requestBody || params.some((p) => p.in === 'body' || p.in === 'formData'),
      });
    }
  }
  return sortRoutes(out);
}

/** "a=1&b=two" -> {a: '1', b: 'two'}; a leading "?" is ignored. */
export function parseQuery(text) {
  return Object.fromEntries(
    new URLSearchParams(
      String(text || '')
        .trim()
        .replace(/^\?/, ''),
    ),
  );
}

/**
 * True when `url` (relative to `origin`), once normalised the way fetch() does it, is the application `app`
 * or a path below it. The check that counts: the URL parser drops tabs and turns \ into /.
 */
export function insideApp(app, url, origin = 'http://x') {
  let target;
  let base;
  try {
    target = new URL(url, origin);
    base = new URL(`${String(app || '').replace(/\/+$/, '')}/`, origin).pathname;
  } catch {
    return false;
  }
  return (
    target.origin === new URL(origin).origin &&
    (target.pathname === base.slice(0, -1) || target.pathname.startsWith(base))
  );
}

/**
 * "/admindeck/api/" + "/whoami" -> "/admindeck/api/whoami". Try it stays inside the application: refuses
 * control characters, backslashes and "." or ".." segments, and checks the normalised result.
 */
export function joinPath(app, path) {
  const raw = String(path || '');
  if (/[\u0000-\u001f\u007f\\]/.test(raw))
    throw new Error('The path must not contain control characters or backslashes.');
  const rest = raw.replace(/^\/+/, '');
  if (
    rest
      .split('?')[0]
      .split('/')
      .some((seg) => {
        let s = seg;
        try {
          s = decodeURIComponent(seg);
        } catch {
          /* keep as typed */
        }
        return s === '.' || s === '..';
      })
  )
    throw new Error('The path must stay inside the application (no . or .. segments).');
  const joined = `${String(app || '').replace(/\/+$/, '')}/${rest}`;
  if (!insideApp(app, joined)) throw new Error('The path must stay inside the application.');
  return joined;
}

export const MAX_BODY = 200_000;

/**
 * The response as plain text: status line, headers, a blank line and the body (JSON indented).
 * It is shown with textContent only, so an HTML error page of IRIS stays text.
 */
export function responseText({ status, statusText = '', headers = [], body = '', ms }) {
  let text = String(body ?? '');
  const type = (headers.find(([k]) => k.toLowerCase() === 'content-type') || [])[1] || '';
  if (/json/i.test(type) || /^\s*[[{]/.test(text)) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* not JSON after all: keep as sent */
    }
  }
  if (text.length > MAX_BODY)
    text = `${text.slice(0, MAX_BODY)}\n… ${(text.length - MAX_BODY).toLocaleString('en-US')} more characters not shown`;
  // fetch reports a redirect it was told not to follow as status 0.
  const line = status === 0 ? 'Redirect (not followed)' : `HTTP ${status}${statusText ? ` ${statusText}` : ''}`;
  return [
    `${line}${ms !== undefined ? ` · ${ms} ms` : ''}`,
    ...headers.map(([k, v]) => `${k}: ${v}`),
    '',
    text || '(empty body)',
  ].join('\n');
}
