import { admin, curl, buildQuery, onCall } from '../api.js';
import { can } from '../app.js';
import { h, page, confirmAction, copy, button, clear, loading, errorBox, toastError, icon } from '../ui.js';

let specPromise;
const methods = ['get', 'post', 'put', 'patch', 'delete'];

function resolve(spec, item, depth = 0) {
  if (!item || depth > 12) return item || {};
  if (item.$ref) {
    const target = item.$ref.split('/').slice(1).reduce((obj, key) => obj?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
    return resolve(spec, target, depth + 1);
  }
  if (item.allOf) return item.allOf.map((part) => resolve(spec, part, depth + 1)).reduce((a, b) => ({
    ...a, ...b, properties: { ...a.properties, ...b.properties }, required: [...new Set([...(a.required || []), ...(b.required || [])])],
  }), {});
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
  if (s.type === 'object' || s.properties) return Object.fromEntries(Object.entries(s.properties || {})
    .filter(([, value]) => !resolve(spec, value).readOnly).map(([key, value]) => [key, example(spec, value, depth + 1)]));
  if (s.type === 'boolean') return false;
  if (s.type === 'integer' || s.type === 'number') return 0;
  return '';
}

function privilege(summary) {
  const matches = [...String(summary || '').matchAll(/%Admin_([A-Za-z0-9_]+):[A-Za-z]+/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

function catalogue(spec) {
  return Object.entries(spec.paths || {}).flatMap(([path, pathItem]) => methods.flatMap((method) => {
    const operation = pathItem[method];
    if (!operation) return [];
    const params = [...(pathItem.parameters || []), ...(operation.parameters || [])].map((p) => resolve(spec, p));
    return [{ method: method.toUpperCase(), path, operation, params, tag: path.split('/')[2] || 'root', privs: privilege(operation.summary) }];
  })).sort((a, b) => a.tag.localeCompare(b.tag) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export default async function render(el) {
  const content = h('div', loading());
  el.append(page('API explorer', 'Inspect the SysAdmin contract and preview exact calls before sending them.', content));
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
      const filtered = entries.filter((e) => `${e.method} ${e.path} ${e.operation.summary || ''}`.toLowerCase().includes(q));
      const groups = new Map();
      for (const entry of filtered) {
        if (!groups.has(entry.tag)) groups.set(entry.tag, []);
        groups.get(entry.tag).push(entry);
      }
      clear(list, [...groups].map(([tag, items]) => h('div', h('h3', tag), items.map((entry) =>
        h('button', { style: { width: '100%', textAlign: 'left', marginBottom: '4px' },
          onclick: () => { selected = entry; showEntry(spec, entry, detail); drawList(); } },
        h(`span.method.${entry.method.toLowerCase()}`, entry.method),
        ` ${entry.path}`, h('div.small.muted', entry.operation.summary || ''),
        entry.privs.length ? privLine('div', entry, entry.privs.join(' or ')) : null,
        entry === selected ? h('span.small', 'Selected') : null)))));
      if (!filtered.length) list.append(h('div.empty-state', 'No matching endpoints.'));
    };
    search.addEventListener('input', drawList);
    clear(content, h('div.grid.wide', h('div.card', search, list), detail));
    drawList();
  } catch (e) { clear(content, errorBox(e)); }
}

function showEntry(spec, entry, container) {
  const op = entry.operation;
  const inputs = entry.params.map((param) => {
    const schema = resolve(spec, param.schema);
    const input = h('input', { type: schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text',
      value: param.example ?? schema.example ?? schema.default ?? '', required: !!param.required,
      placeholder: param.description?.replace(/<[^>]*>/g, ' ').slice(0, 100) || '' });
    return { param, input };
  });
  const request = resolve(spec, op.requestBody);
  const bodySchema = resolve(spec, request.content?.['application/json']?.schema);
  const bodyInput = request.content?.['application/json'] ? h('textarea.mono', { rows: 13 }, JSON.stringify(example(spec, bodySchema), null, 2)) : null;
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
      try { body = JSON.parse(bodyInput.value); } catch { throw new Error('Request body must be valid JSON.'); }
    }
    return { path, query, body, full: `/api/admin${path}${buildQuery(query)}` };
  };
  const execute = async () => {
    try {
      const call = build();
      const run = async () => {
        const start = performance.now();
        let status;
        const unsubscribe = onCall((entry) => {
          if (entry.method === entryMethod && entry.url === call.full) status = entry.status;
        });
        const entryMethod = entry.method;
        clear(output, loading());
        try {
          const result = await admin.request(entry.method, call.path, { query: call.query, body: call.body });
          clear(output, h('p.small.muted', `${status ? `HTTP ${status}` : 'Success'} · ${Math.round(performance.now() - start)} ms`),
            h('pre', JSON.stringify(result, null, 2) ?? 'No response body'));
          return result;
        } catch (e) {
          clear(output, h('p.small.muted', `${e.status ? `HTTP ${e.status}` : 'Request failed'} · ${Math.round(performance.now() - start)} ms`),
            errorBox(e), e.payload ? h('pre', JSON.stringify(e.payload, null, 2)) : null);
          return false;
        } finally { unsubscribe(); }
      };
      if (entry.method === 'GET') await run();
      else await confirmAction({ title: `${entry.method} ${entry.path}`, message: op.description || op.summary || 'Send this API request?',
        call: { method: entry.method, path: call.full, body: call.body }, danger: entry.method === 'DELETE', run });
    } catch (e) { toastError(e); }
  };
  clear(container,
    h('h2', `${entry.method} ${entry.path}`), h('p', op.summary || ''), op.description ? h('p.muted', op.description) : null,
    entry.privs.length ? privLine('p', entry, `${entry.privs.some((p) => can(p)) ? 'Available' : 'Privilege unavailable'}: ${entry.privs.join(' or ')}`) : null,
    inputs.length ? [h('h3', 'Parameters'), h('div.form-grid', inputs.map(({ param, input }) =>
      h('div.field', h('label', `${param.name}${param.required ? ' *' : ''} (${param.in})`), input)))] : null,
    bodyInput ? [h('h3', 'JSON body'), bodyInput] : null,
    h('div.toolbar', button('Send', execute, 'primary'), button('Copy as curl', () => {
      try { const call = build(); copy(curl(entry.method, call.full, call.body)); } catch (e) { toastError(e); }
    })), output);
}

// Privilege hint: check or cross icon (coloured by availability) followed by the text.
function privLine(tag, entry, text) {
  const ok = entry.privs.some((p) => can(p));
  return h(`${tag}.small.priv.${ok ? 'ok' : 'no'}`, icon(ok ? 'check' : 'close'), h('span', text));
}
