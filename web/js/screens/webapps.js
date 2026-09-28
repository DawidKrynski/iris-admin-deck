import { admin } from '../api.js';
import { can } from '../app.js';
import { authMethods } from '../iris.js';
import { h, page, table, load, modal, confirmAction, applyVerified, objectForm, diff, fmtValue, badge, toast, toastError, apiCallPreview, button, toolbar, clear, icon } from '../ui.js';

const FIELDS = [
  { key: 'Description', type: 'textarea' }, { key: 'NameSpace', label: 'Namespace', required: true },
  { key: 'DispatchClass', label: 'Dispatch class' }, { key: 'Path' }, { key: 'Enabled', type: 'bool' },
  { key: 'JWTAuthEnabled', label: 'JWT authentication', type: 'bool' },
  { key: 'MatchRoles', type: 'json' }, { key: 'Resource' }, { key: 'ServeFiles', type: 'select', options: ['No', 'Always', 'Always and cached', 'Use CSP security'] },
  { key: 'CorsAllowlist', label: 'CORS allowlist', type: 'json' },
];
const AUTH = [[32, 'Password'], [64, 'Unauthenticated'], [4, 'Kerberos'], [8192, 'Delegated']];
const path = (name) => `/api/admin/v2/web-app?name=${encodeURIComponent(name)}`;
const readApp = (name) => admin.get('/v2/web-app', { name });
const system = (a) => a.IsSystemApp || a.NamespaceDefault || a.IsNameSpaceDefault || /^\/csp\/sys(?:\/|$)|^\/api\//i.test(a.Name);
// Apps this portal (or the classic portal) needs to work: never disable or delete them from here.
const protectedApp = (name) => /^\/csp\/sys(?:\/|$)|^\/api\/admin(?:\/|$)|^\/admindeck(?:\/|$)/i.test(name);
const kind = (a) => a.DispatchClass ? 'REST' : /wsgi/i.test(a.Type || '') ? 'WSGI' : 'CSP/static';
function authNames(a) {
  if (Array.isArray(a.AuthenticationMethods)) return a.AuthenticationMethods.join(', ') || '—';
  return authMethods(a.AutheEnabled).join(', ') || '—';
}

// Details grouped like the SMP web application page. [property, label, format?]
const seconds = (v) => (v === '' || v === undefined ? '—' : `${v} s`);
const SECTIONS = [
  ['General', [['Description'], ['NameSpace', 'Namespace'], ['Enabled'], ['DispatchClass', 'Dispatch class'],
    ['Path', 'CSP files path'], ['Recurse', 'Include subdirectories'], ['ServeFiles', 'Serve files'],
    ['ServeFilesTimeout', 'Serve files timeout', seconds], ['IsNameSpaceDefault', 'Namespace default'],
    ['RedirectEmptyPath', 'Redirect empty path'], ['AutoCompile', 'Auto compile'], ['LockCSPName', 'Lock CSP name']]],
  ['Security', [['AutheEnabled', 'Allowed authentication', (v) => `${authMethods(v).join(', ') || 'none'} (${v})`],
    ['JWTAuthEnabled', 'JWT authentication'], ['JWTAccessTokenTimeout', 'JWT access token timeout', seconds],
    ['JWTRefreshTokenTimeout', 'JWT refresh token timeout', seconds], ['TwoFactorEnabled', 'Two-factor'],
    ['Resource', 'Required resource'], ['MatchRoles', 'Application roles', matchRoles], ['PermittedClasses', 'Permitted classes'],
    ['CSRFToken', 'CSRF token'], ['CorsAllowlist', 'CORS allowlist'], ['CorsCredentialsAllowed', 'CORS credentials'],
    ['CorsHeadersList', 'CORS headers']]],
  ['Session', [['Timeout', 'Session timeout', seconds], ['UseCookies', 'Use cookie for session'], ['CookiePath', 'Session cookie path'],
    ['SessionScope', 'Session cookie scope'], ['UserCookieScope', 'User cookie scope'], ['GroupById', 'Group by ID'],
    ['EventClass', 'Event class'], ['SuperClass', 'Super class'], ['Package', 'Default package'], ['LoginPage', 'Login page'],
    ['ChangePasswordPage', 'Change password page'], ['ErrorPage', 'Custom error page']]],
  ['Enabled for', [['CSPZENEnabled', 'CSP/ZEN'], ['DeepSeeEnabled', 'Analytics (DeepSee)'], ['iKnowEnabled', 'iKnow'],
    ['InbndWebServicesEnabled', 'Inbound web services'], ['TraceEnabled', 'Trace']]],
  ['WSGI', [['WSGIType', 'Type'], ['WSGIAppLocation', 'App location'], ['WSGIAppName', 'App name'], ['WSGICallable', 'Callable'],
    ['WSGIDebug', 'Debug']]],
];
// MatchRoles: {MatchRole, TargetRoles} (or a list of them); an empty MatchRole means every user.
function matchRoles(v) {
  if (typeof v === 'string') return v || '—';
  const list = (Array.isArray(v) ? v : [v]).filter((m) => m && (m.TargetRoles || []).length);
  return list.map((m) => `${m.MatchRole ? `holders of ${m.MatchRole}` : 'every user'} → ${m.TargetRoles.join(', ')}`).join('; ') || '—';
}
function settings(a) {
  const shown = new Set(SECTIONS.flatMap(([, rows]) => rows.map(([k]) => k)));
  const other = Object.keys(a).filter((k) => !shown.has(k)).map((k) => [k]);
  // The WSGI defaults (Callable "app") are noise on applications that are not WSGI.
  const sections = [...SECTIONS.filter(([t]) => t !== 'WSGI' || a.WSGIAppName || a.WSGIAppLocation), ['Other', other]];
  return sections.map(([title, rows]) => {
    const present = rows.filter(([k]) => k in a);
    return present.length ? [h('h3', title), h('dl.kv.sections', present.map(([k, label, fmt]) => [
      h('dt', { title: k }, label || k), h('dd', fmt ? fmt(a[k]) : fmtValue(a[k]))]))] : null;
  });
}
export default async function render(el, params) {
  const body = h('div');
  el.append(page('Web apps & REST', null, body));
  let filter = 'All';
  const reload = () => load(body, () => admin.get('/v2/web-apps'), (rows) => {
    const shown = rows.filter((a) => filter === 'All' || filter === 'System' && system(a) || filter === 'REST' && kind(a) === 'REST' || filter === 'CSP' && kind(a) !== 'REST' && !system(a));
    return [toolbar(
      ...['All', 'REST', 'CSP', 'System'].map((f) => button(f, () => { filter = f; reload(); }, filter === f ? 'primary' : 'small')),
      can('Secure') ? button([icon('plus'), 'New REST API'], () => edit(null, 'REST', reload), 'primary') : null,
      can('Secure') ? button([icon('plus'), 'New static/CSP app'], () => edit(null, 'CSP', reload)) : null,
      button('Refresh', reload)),
    table([
      { key: 'Name', label: 'Application' },
      { key: 'Type', label: 'Type', render: (a) => badge(kind(a)) },
      { key: 'Namespace', label: 'Namespace' },
      { key: 'Enabled', label: 'State', render: (a) => badge(a.Enabled ? 'Enabled' : 'Disabled', a.Enabled ? 'ok' : 'muted') },
      { key: 'AuthenticationMethods', label: 'Authentication', render: authNames },
      { key: 'JWTAuthEnabled', label: 'JWT', render: (a) => a.JWTAuthEnabled === undefined ? 'See details' : a.JWTAuthEnabled ? badge('On', 'ok') : 'Off' },
    ], shown, { sortKey: 'Name', onRow: (a) => details(a.Name, reload), empty: 'No applications in this group.' })];
  });
  await reload();
  if (params?.[0]) details(params[0], reload);
}
async function details(name, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(name, body, { wide: true });
  try {
    const a = await readApp(name);
    clear(body, toolbar(
      can('Secure') ? button('Edit', () => { m.close(); edit({ ...a, Name: name }, null, reload); }) : null,
      can('Secure') && !(a.Enabled && protectedApp(name)) ? button(a.Enabled ? 'Disable' : 'Enable', () => confirmAction({
        title: `${a.Enabled ? 'Disable' : 'Enable'} ${name}`,
        message: a.Enabled ? 'Requests to this application will stop working.' : 'Requests to this application will be accepted again.',
        call: { method: 'PUT', path: path(name), body: { Enabled: !a.Enabled } }, danger: a.Enabled,
        run: () => admin.put('/v2/web-app', { Enabled: !a.Enabled }, { name }), done: 'Application updated',
        verify: { read: () => readApp(name), changes: { Enabled: !a.Enabled } },
      }).then((ok) => { if (ok) { m.close(); reload(); } })) : null,
      can('Secure') ? h('button.danger', { disabled: protectedApp(name), title: protectedApp(name) ? 'Built-in administration applications cannot be deleted here' : 'Delete application', onclick: () => confirmAction({
        title: `Delete ${name}`, message: 'This permanently removes the web application and its routing configuration.',
        call: { method: 'DELETE', path: path(name) }, danger: true, confirmLabel: 'Delete',
        confirmText: name, run: () => admin.del('/v2/web-app', { name }),
        verify: { read: () => readApp(name), expect: 'gone' }, done: 'Application deleted',
      }).then((ok) => { if (ok) { m.close(); reload(); } }) }, 'Delete') : null),
    settings(a));
  } catch (e) { clear(body, h('div.error-box', e.message)); }
}
// IRIS 2026.2: when PUT /v2/web-app creates a new application, ServeFiles/UseCookies are validated
// against the numeric VALUELIST of Security.Applications (0-3), although GET returns and edits accept
// the documented strings. Send the numeric codes only on create.
const SERVE_FILES = { No: 0, Always: 1, 'Always and cached': 2, 'Use CSP security': 3 };
const USE_COOKIES = { Never: 0, AutoDetect: 1, Always: 2 };
function createCompat(fields) {
  const out = { ...fields };
  if (out.ServeFiles in SERVE_FILES) out.ServeFiles = SERVE_FILES[out.ServeFiles];
  if (out.UseCookies in USE_COOKIES) out.UseCookies = USE_COOKIES[out.UseCookies];
  return out;
}
function edit(app, preset, reload) {
  const fresh = !app;
  const initial = app || { Name: '', Description: '', NameSpace: 'USER', DispatchClass: '', Path: '', Enabled: true, JWTAuthEnabled: preset === 'REST', AutheEnabled: 32, MatchRoles: [], Resource: '', ServeFiles: preset === 'REST' ? 'No' : 'Always', CorsAllowlist: [] };
  const nameInput = fresh ? h('input', { type: 'text', value: initial.Name, placeholder: '/api/my-app', required: true }) : null;
  const form = objectForm(initial, FIELDS);
  const auth = AUTH.map(([bit, label]) => [bit, h('input', { type: 'checkbox', checked: !!(Number(initial.AutheEnabled || 0) & bit) }), label]);
  const preview = h('div');
  const build = () => {
    const name = fresh ? nameInput.value.trim() : app.Name;
    if (!name.startsWith('/')) throw new Error('Application name must start with /.');
    const fields = form.value();
    const known = AUTH.reduce((n, [bit]) => n | bit, 0);
    fields.AutheEnabled = (Number(initial.AutheEnabled || 0) & ~known) | auth.reduce((n, [bit, input]) => n | (input.checked ? bit : 0), 0);
    if (fresh && preset === 'REST' && !fields.DispatchClass) throw new Error('Dispatch class is required for REST APIs.');
    // Same guard as the Disable button: apps this portal needs stay enabled and keep their sign-in method.
    if (!fresh && protectedApp(name)) {
      if (fields.Enabled === false) throw new Error(`${name} is needed by this portal and cannot be disabled here.`);
      if (!(fields.AutheEnabled & 32) && (Number(app.AutheEnabled || 0) & 32)) throw new Error(`Password authentication is required on ${name}.`);
    }
    return { name, body: fresh ? createCompat(fields) : diff(app, fields) };
  };
  modal(fresh ? `New ${preset} application` : `Edit ${app.Name}`, [
    fresh ? h('div.field', h('label', 'Application name'), nameInput) : null,
    form.el, h('div.field', h('label', 'Authentication methods'), auth.map(([, input, label]) => h('label', input, ` ${label} `))),
    toolbar(button('Preview API call', () => { try { const c = build(); clear(preview, apiCallPreview('PUT', path(c.name), c.body)); } catch (e) { toastError(e); } }, 'small')), preview,
  ], { wide: true, actions: [{ label: 'Cancel', onclick: () => {} }, { label: fresh ? 'Create' : 'Save changes', kind: 'primary', onclick: async () => {
    const c = build();
    if (!Object.keys(c.body).length) { toast('No changes', 'warn'); return false; }
    // PUT creates or updates: creating must never silently reconfigure an existing application.
    if (fresh && await readApp(c.name).then(() => true, (e) => { if (e.status === 404 || /does not exist/i.test(e.message)) return false; throw e; })) {
      throw new Error(`${c.name} already exists. Open it from the list to change it.`);
    }
    await applyVerified({
      ...(!fresh ? { original: app, changes: c.body } : { expect: 'exists' }),
      read: () => readApp(c.name), write: () => admin.put('/v2/web-app', c.body, { name: c.name }),
    }, fresh ? 'Application created' : 'Application saved');
    reload();
  } }] });
}
