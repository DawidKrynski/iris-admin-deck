import { admin, ext, curl, buildQuery, onCall, rawCall, PREFIX } from '../api.js';
import { can } from '../app.js';
import {
  h,
  page,
  tabs,
  badge,
  confirmAction,
  copy,
  button,
  clear,
  loading,
  errorBox,
  toastError,
  icon,
} from '../ui.js';
import {
  mergeApps,
  routesFromSpec,
  routesFromUrlMap,
  pathParams,
  fillPath,
  isPattern,
  parseQuery,
  joinPath,
  insideApp,
  responseText,
} from '../restapps.js';
import { redactPath } from '../changes.js';

let specPromise;
const methods = ['get', 'post', 'put', 'patch', 'delete'];

function resolve(spec, item, depth = 0) {
  if (!item || depth > 12) return item || {};
  if (item.$ref) {
    const target = item.$ref
      .split('/')
      .slice(1)
      .reduce((obj, key) => obj?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    return resolve(spec, target, depth + 1);
  }
  if (item.allOf)
    return item.allOf
      .map((part) => resolve(spec, part, depth + 1))
      .reduce(
        (a, b) => ({
          ...a,
          ...b,
          properties: { ...a.properties, ...b.properties },
          required: [...new Set([...(a.required || []), ...(b.required || [])])],
        }),
        {},
      );
  return item;
}

function example(spec, schema, depth = 0) {
  const s = resolve(spec, schema);
  if (depth > 5) return null;
  if (s.example !== undefined) return s.example;
  if (s.default !== undefined) return s.default;
  if (s.enum?.length) return s.enum[0];
  if (s.oneOf?.length || s.anyOf?.length) return example(spec, (s.oneOf || s.anyOf)[0], depth + 1);
  if (s.type === 'array') return [example(spec, s.items, depth + 1)];
  if (s.type === 'object' || s.properties)
    return Object.fromEntries(
      Object.entries(s.properties || {})
        .filter(([, value]) => !resolve(spec, value).readOnly)
        .map(([key, value]) => [key, example(spec, value, depth + 1)]),
    );
  if (s.type === 'boolean') return false;
  if (s.type === 'integer' || s.type === 'number') return 0;
  return '';
}

function privilege(summary) {
  const matches = [...String(summary || '').matchAll(/%Admin_([A-Za-z0-9_]+):[A-Za-z]+/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

function catalogue(spec) {
  return Object.entries(spec.paths || {})
    .flatMap(([path, pathItem]) =>
      methods.flatMap((method) => {
        const operation = pathItem[method];
        if (!operation) return [];
        const params = [...(pathItem.parameters || []), ...(operation.parameters || [])].map((p) => resolve(spec, p));
        return [
          {
            method: method.toUpperCase(),
            path,
            operation,
            params,
            tag: path.split('/')[2] || 'root',
            privs: privilege(operation.summary),
          },
        ];
      }),
    )
    .sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export default async function render(el) {
  el.append(
    page(
      'API explorer',
      null,
      tabs([
        { id: 'sysadmin', label: 'SysAdmin API', render: sysAdminTab },
        { id: 'instance', label: 'REST APIs on this instance', render: instanceTab },
      ]),
    ),
  );
}

async function sysAdminTab(el) {
  const content = h('div', loading());
  el.append(content);
  try {
    specPromise ||= fetch('openapi.json').then((response) => {
      if (!response.ok) throw new Error(`OpenAPI specification: HTTP ${response.status}`);
      return response.json();
    });
    const spec = await specPromise;
    const entries = catalogue(spec);
    const search = h('input', { type: 'search', placeholder: 'Search endpoints…', 'aria-label': 'Search endpoints' });
    const list = h('div');
    const detail = h('div.card', h('p.muted', 'Select an endpoint.'));
    let selected;
    const drawList = () => {
      const q = search.value.toLowerCase();
      const filtered = entries.filter((e) =>
        `${e.method} ${e.path} ${e.operation.summary || ''}`.toLowerCase().includes(q),
      );
      const groups = new Map();
      for (const entry of filtered) {
        if (!groups.has(entry.tag)) groups.set(entry.tag, []);
        groups.get(entry.tag).push(entry);
      }
      clear(
        list,
        [...groups].map(([tag, items]) =>
          h(
            'div',
            h('h3', tag),
            items.map((entry) =>
              h(
                'button',
                {
                  style: { width: '100%', textAlign: 'left', marginBottom: '4px' },
                  onclick: () => {
                    selected = entry;
                    showEntry(spec, entry, detail);
                    drawList();
                  },
                },
                h(`span.method.${entry.method.toLowerCase()}`, entry.method),
                ` ${entry.path}`,
                h('div.small.muted', entry.operation.summary || ''),
                entry.privs.length ? privLine('div', entry, entry.privs.join(' or ')) : null,
                entry === selected ? h('span.small', 'Selected') : null,
              ),
            ),
          ),
        ),
      );
      if (!filtered.length) list.append(h('div.empty-state', 'No matching endpoints.'));
    };
    search.addEventListener('input', drawList);
    clear(content, h('div.grid.wide', h('div.card', search, list), detail));
    drawList();
  } catch (e) {
    clear(content, errorBox(e));
  }
}

function showEntry(spec, entry, container) {
  const op = entry.operation;
  const inputs = entry.params.map((param) => {
    const schema = resolve(spec, param.schema);
    const input = h('input', {
      type: schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text',
      'aria-label': `${param.name} (${param.in})`,
      value: param.example ?? schema.example ?? schema.default ?? '',
      required: !!param.required,
      placeholder: param.description?.replace(/<[^>]*>/g, ' ').slice(0, 100) || '',
    });
    return { param, input };
  });
  const request = resolve(spec, op.requestBody);
  const bodySchema = resolve(spec, request.content?.['application/json']?.schema);
  const bodyInput = request.content?.['application/json']
    ? h(
        'textarea.mono',
        { rows: 13, 'aria-label': 'JSON request body' },
        JSON.stringify(example(spec, bodySchema), null, 2),
      )
    : null;
  const output = h('div');
  const build = () => {
    let path = entry.path;
    const query = {};
    for (const { param, input } of inputs) {
      const value = input.value.trim();
      if (param.required && !value) throw new Error(`${param.name} is required.`);
      if (param.in === 'path') path = path.replace(`{${param.name}}`, encodeURIComponent(value));
      else if (value) query[param.name] = value;
    }
    if (/\{[^}]+\}/.test(path)) throw new Error('Fill all path parameters.');
    let body;
    if (bodyInput && bodyInput.value.trim()) {
      try {
        body = JSON.parse(bodyInput.value);
      } catch {
        throw new Error('Request body must be valid JSON.');
      }
    }
    return { path, query, body, full: `/api/admin${path}${buildQuery(query)}` };
  };
  const execute = async () => {
    try {
      const call = build();
      // An error answer is shown as it is and logged as failed, not as an accepted change.
      let failure = null;
      const run = async () => {
        failure = null;
        const start = performance.now();
        let status;
        const unsubscribe = onCall((entry) => {
          if (entry.method === entryMethod && entry.url === call.full) status = entry.status;
        });
        const entryMethod = entry.method;
        clear(output, loading());
        try {
          const result = await admin.request(entry.method, call.path, { query: call.query, body: call.body });
          clear(
            output,
            h(
              'p.small.muted',
              `${status ? `HTTP ${status}` : 'Success'} · ${Math.round(performance.now() - start)} ms`,
            ),
            h('pre', JSON.stringify(result, null, 2) ?? 'No response body'),
          );
          return result;
        } catch (e) {
          failure = e.status ? `HTTP ${e.status}` : String(e.message || 'Request failed');
          clear(
            output,
            h(
              'p.small.muted',
              `${e.status ? `HTTP ${e.status}` : 'Request failed'} · ${Math.round(performance.now() - start)} ms`,
            ),
            errorBox(e),
            e.payload ? h('pre', JSON.stringify(e.payload, null, 2)) : null,
          );
          return false;
        } finally {
          unsubscribe();
        }
      };
      if (entry.method === 'GET') await run();
      else
        await confirmAction({
          title: `${entry.method} ${entry.path}`,
          message: op.description || op.summary || 'Send this API request?',
          call: { method: entry.method, path: call.full, body: call.body },
          danger: entry.method === 'DELETE',
          run,
          outcome: () => (failure ? { outcome: 'failed', details: failure } : { outcome: 'unverified' }),
        });
    } catch (e) {
      toastError(e);
    }
  };
  clear(
    container,
    h('h2', `${entry.method} ${entry.path}`),
    h('p', op.summary || ''),
    op.description ? h('p.muted', op.description) : null,
    entry.privs.length
      ? privLine(
          'p',
          entry,
          `${entry.privs.some((p) => can(p)) ? 'Available' : 'Privilege unavailable'}: ${entry.privs.join(' or ')}`,
        )
      : null,
    inputs.length
      ? [
          h('h3', 'Parameters'),
          h(
            'div.form-grid',
            inputs.map(({ param, input }) =>
              h('div.field', h('label', `${param.name}${param.required ? ' *' : ''} (${param.in})`), input),
            ),
          ),
        ]
      : null,
    bodyInput ? [h('h3', 'JSON body'), bodyInput] : null,
    h(
      'div.toolbar',
      button('Send', execute, 'primary'),
      button('Copy as curl', () => {
        try {
          const call = build();
          copy(curl(entry.method, call.full, call.body));
        } catch (e) {
          toastError(e);
        }
      }),
    ),
    output,
  );
}

// Privilege hint: check or cross icon (coloured by availability) followed by the text.
function privLine(tag, entry, text) {
  const ok = entry.privs.some((p) => can(p));
  return h(`${tag}.small.priv.${ok ? 'ok' : 'no'}`, icon(ok ? 'check' : 'close'), h('span', text));
}

// ---------- REST APIs on this instance ----------
// The list: /v2/web-apps rows with a dispatch class, merged with the extension's /restapps (the list of
// /api/mgmnt, which itself takes only basic auth, so the browser cannot call it). Routes come from the
// extension: the OpenAPI spec of a spec-first application, otherwise the UrlMap of its dispatch class.
const MAX_ROUTES = 200;

async function instanceTab(el) {
  const content = h('div', loading());
  el.append(content);
  const [web, listed] = await Promise.allSettled([
    admin.get('/v2/web-apps'),
    ext.loggedIn ? ext.get('/restapps') : Promise.reject(new Error('the extension API is not signed in')),
  ]);
  if (web.status === 'rejected' && listed.status === 'rejected') {
    clear(content, errorBox(web.reason));
    return;
  }
  const apps = mergeApps(web.value, listed.value);
  const search = h('input', {
    type: 'search',
    placeholder: 'Search applications…',
    'aria-label': 'Search REST applications',
  });
  const list = h('div');
  const detail = h('div.card', h('p.muted', 'Select a REST application.'));
  let selected;
  const drawList = () => {
    const q = search.value.toLowerCase();
    const shown = apps.filter((a) => `${a.name} ${a.namespace} ${a.dispatchClass}`.toLowerCase().includes(q));
    clear(
      list,
      shown.map((a) =>
        h(
          'button.rest-app',
          {
            style: { width: '100%', textAlign: 'left', marginBottom: '4px' },
            onclick: () => {
              selected = a;
              showApp(a, detail);
              drawList();
            },
          },
          h('strong', a.name),
          a.enabled ? null : [' ', badge('Disabled', 'muted')],
          a.specFirst ? [' ', badge('Spec-first')] : null,
          h('div.small.muted', `${a.namespace} · ${a.dispatchClass}`),
          a === selected ? h('span.small', 'Selected') : null,
        ),
      ),
    );
    if (!shown.length)
      list.append(
        h('div.empty-state', apps.length ? 'No matching applications.' : 'No web application has a dispatch class.'),
      );
  };
  search.addEventListener('input', drawList);
  clear(
    content,
    listed.status === 'rejected' ? h('p.small.muted', `Routes cannot be read: ${listed.reason.message}.`) : null,
    web.status === 'rejected'
      ? h(
          'p.small.muted',
          `The SysAdmin web application list failed (${web.reason.message}); showing the extension's list only.`,
        )
      : null,
    h('div.grid.wide', h('div.card', search, list), detail),
  );
  drawList();
}

// How Try it signs in: the portal's JWT where the application accepts JWT, nothing where it allows
// unauthenticated access, otherwise it cannot sign in (the password is never kept) and curl uses -u.
function authPlan(webApp) {
  if (!webApp)
    return {
      auth: true,
      basic: false,
      note: 'Try it sends your portal token (JWT). The application settings could not be read, so it may answer 401.',
    };
  if (webApp.JWTAuthEnabled)
    return { auth: true, basic: false, note: 'Try it sends your portal token (JWT), which this application accepts.' };
  if (Number(webApp.AutheEnabled) & 64)
    return {
      auth: false,
      basic: false,
      note: 'This application allows unauthenticated access; Try it sends no token.',
    };
  return {
    auth: false,
    basic: true,
    note: 'JWT authentication is off for this application, so Try it cannot sign in and IRIS will answer 401. Copy curl signs in with -u instead.',
  };
}

async function showApp(app, container) {
  clear(container, h('h2', app.name), loading());
  const [info, settings] = await Promise.allSettled([
    ext.get('/restapps/routes', { app: app.name }),
    admin.get('/v2/web-app', { name: app.name }),
  ]);
  const plan = authPlan(settings.value);
  const d = info.value;
  let routes = [];
  let source = '';
  const problems = [];
  if (info.status === 'rejected') problems.push(info.reason.message);
  else {
    if (d.spec) {
      routes = routesFromSpec(d.spec);
      source = 'OpenAPI specification (spec-first, as /api/mgmnt serves it)';
    } else if (d.specError) problems.push(`OpenAPI specification: ${d.specError}`);
    if (!d.spec && d.routes) {
      routes = routesFromUrlMap(d.routes);
      source = `UrlMap of ${d.dispatchClass}`;
    } else if (!d.spec && d.routesError) problems.push(`UrlMap: ${d.routesError}`);
  }
  const header = [
    h('h2', app.name),
    h(
      'p.small.muted',
      `Namespace ${d?.namespace || app.namespace} · dispatch class ${d?.dispatchClass || app.dispatchClass}${source ? ` · routes from the ${source}` : ''}`,
    ),
    h('p.small', plan.note),
  ];
  if (!source) {
    clear(
      container,
      header,
      h(
        'div.error-box',
        h('strong', 'Routes are not readable'),
        problems.map((p) => h('p', p)),
        h('p.muted', 'Neither an OpenAPI specification nor a UrlMap could be read for this application.'),
      ),
    );
    return;
  }
  const search = h('input', { type: 'search', placeholder: 'Search routes…', 'aria-label': 'Search routes' });
  const list = h('div.route-list', { style: { maxHeight: '40vh', overflowY: 'auto' } });
  const tryBox = h('div');
  let chosen;
  const drawRoutes = () => {
    const q = search.value.toLowerCase();
    const shown = routes.filter((r) => `${r.method} ${r.path} ${r.summary}`.toLowerCase().includes(q));
    clear(
      list,
      shown.slice(0, MAX_ROUTES).map((r) =>
        h(
          'button.route',
          {
            style: { width: '100%', textAlign: 'left', marginBottom: '4px' },
            onclick: () => {
              chosen = r;
              tryRoute(app, r, plan, tryBox);
              drawRoutes();
            },
          },
          h(`span.method.${r.method.toLowerCase()}`, r.method),
          ` ${r.path}`,
          r.summary ? h('div.small.muted', r.summary) : null,
          r === chosen ? h('span.small', 'Selected') : null,
        ),
      ),
    );
    if (shown.length > MAX_ROUTES)
      list.append(h('p.small.muted', `Showing ${MAX_ROUTES} of ${shown.length} routes; refine the search.`));
    if (!shown.length)
      list.append(h('div.empty-state', routes.length ? 'No matching routes.' : 'This application defines no routes.'));
  };
  search.addEventListener('input', drawRoutes);
  clear(
    container,
    header,
    problems.length ? h('p.small.muted', problems.join(' · ')) : null,
    h('h3', `Routes (${routes.length})`),
    search,
    list,
    tryBox,
  );
  drawRoutes();
}

function tryRoute(app, route, plan, container) {
  const pathInput = h('input.mono', { type: 'text', value: route.path, 'aria-label': 'Path inside the application' });
  const fields = new Map();
  const field = (name, where, required, description) => {
    const input = h('input', {
      type: 'text',
      required,
      placeholder: description?.replace(/<[^>]*>/g, ' ').slice(0, 100) || '',
      'aria-label': `${name} (${where})`,
    });
    fields.set(`${where}:${name}`, { name, where, required, input });
    return h('div.field', h('label', `${name}${required ? ' *' : ''} (${where})`), input);
  };
  const queryParams = route.params.filter((p) => p.in === 'query');
  const extraQuery = h('input', { type: 'text', placeholder: 'a=1&b=2', 'aria-label': 'Other query parameters' });
  const withBody = route.body || /^(POST|PUT|PATCH)$/.test(route.method);
  const bodyInput = withBody ? h('textarea.mono', { rows: 8, placeholder: '{ }', 'aria-label': 'JSON body' }) : null;
  const pathFields = h('div.form-grid');
  // Path fields follow the path: editing it (e.g. a UrlMap pattern into a real path) redraws them.
  const drawPathFields = () => {
    const old = new Map([...fields].filter(([k]) => k.startsWith('path:')).map(([k, f]) => [k, f.input.value]));
    for (const k of [...fields.keys()]) if (k.startsWith('path:')) fields.delete(k);
    clear(
      pathFields,
      pathParams(pathInput.value).map((name) => {
        const desc = route.params.find((p) => p.in === 'path' && p.name === name)?.description;
        const node = field(name, 'path', true, desc);
        fields.get(`path:${name}`).input.value = old.get(`path:${name}`) || '';
        return node;
      }),
    );
  };
  pathInput.addEventListener('input', drawPathFields);
  drawPathFields();
  const output = h('div');
  const build = () => {
    const template = pathInput.value.trim();
    if (!template.startsWith('/')) throw new Error('The path must start with /.');
    const values = Object.fromEntries(
      [...fields.values()].filter((f) => f.where === 'path').map((f) => [f.name, f.input.value]),
    );
    const path = fillPath(template, values);
    if (isPattern(path))
      throw new Error('This route is a pattern (a regular expression). Edit the path into a concrete URL first.');
    const query = { ...parseQuery(extraQuery.value) };
    for (const f of fields.values()) {
      if (f.where !== 'query') continue;
      const value = f.input.value.trim();
      if (f.required && !value) throw new Error(`${f.name} is required.`);
      if (value) query[f.name] = value;
    }
    let body;
    if (bodyInput && bodyInput.value.trim()) {
      try {
        body = JSON.parse(bodyInput.value);
      } catch {
        throw new Error('Request body must be valid JSON.');
      }
    }
    const full = `${joinPath(app.name, path)}${buildQuery(query)}`;
    // What fetch() really requests, once the browser has normalised the URL, must still be inside the application.
    if (!insideApp(`${PREFIX}${app.name}`, `${PREFIX}${full}`, location.origin))
      throw new Error('The path must stay inside the application.');
    return { body, full };
  };
  const execute = async () => {
    try {
      const call = build();
      const run = async () => {
        clear(output, loading());
        try {
          const res = await rawCall(route.method, call.full, { body: call.body, auth: plan.auth });
          clear(output, h('pre.response', responseText(res)));
          return { status: res.status };
        } catch (e) {
          clear(output, errorBox(e));
          return { error: String(e.message || e) };
        }
      };
      // Shown whatever the status; logged as failed when the application answered with an error.
      const outcome = (r) =>
        r && r.error
          ? { outcome: 'failed', details: r.error }
          : r && r.status >= 400
            ? { outcome: 'failed', details: `HTTP ${r.status}` }
            : { outcome: 'unverified' };
      if (route.method === 'GET') await run();
      else
        await confirmAction({
          title: `${route.method} ${call.full}`,
          message: 'Send this request? It goes to the application exactly as shown and may change data.',
          call: { method: route.method, path: call.full, body: call.body, basic: plan.basic },
          danger: route.method === 'DELETE',
          confirmLabel: 'Send',
          run,
          what: `${route.method} ${redactPath(call.full)}`,
          outcome,
        });
    } catch (e) {
      toastError(e);
    }
  };
  clear(
    container,
    h('h3', 'Try it: ', h(`span.method.${route.method.toLowerCase()}`, route.method), ` ${route.path}`),
    route.description ? h('p.small.muted', route.description) : null,
    h('div.field', h('label', `Path inside ${app.name}`), pathInput),
    pathFields,
    h(
      'div.form-grid',
      queryParams.map((p) => field(p.name, 'query', p.required, p.description)),
      h('div.field', h('label', 'Other query parameters'), extraQuery),
    ),
    bodyInput ? h('div.field', h('label', 'JSON body'), bodyInput) : null,
    h(
      'div.toolbar',
      button('Send', execute, 'primary'),
      button('Copy curl', () => {
        try {
          const call = build();
          copy(curl(route.method, call.full, call.body, { basic: plan.basic }));
        } catch (e) {
          toastError(e);
        }
      }),
    ),
    output,
  );
}
