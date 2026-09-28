import { admin, buildQuery } from '../api.js';
import { can, navigate, session } from '../app.js';
import { h, page, table, tabs, load, modal, confirmAction, applyVerified, objectForm, diff, kv, badge, toast, toastError, apiCallPreview, button, toolbar, clear, icon, loading, errorBox } from '../ui.js';

const qp = (name) => `?name=${encodeURIComponent(name)}`;
const readRole = (name) => admin.get('/v2/security/role', { name });
const readResource = (name) => admin.get('/v2/security/resource', { name });
const readService = (name) => admin.get('/v2/security/service', { name });
const EDIT = [{ key: 'Description', type: 'textarea' }, { key: 'GrantedRoles', type: 'json' }, { key: 'EscalationOnly', type: 'bool' }, { key: 'Resources', type: 'json', help: 'Array of {Name, Permissions} grants.' }];
export default async function render(el, params) {
  el.append(page('Roles & permissions', null, tabs([
    // #/roles/roles/<name> (e.g. from the command palette) opens that role
    { id: 'roles', label: 'Roles', render: (body) => rolesTab(body, params && params[0] === 'roles' ? params[1] : null) },
    { id: 'resources', label: 'Resources', render: resourcesTab },
    { id: 'matrix', label: 'Access matrix', render: matrixTab },
    { id: 'services', label: 'Services', render: servicesTab },
    // #/roles/sql/<user or role> shows the SQL privileges of that grantee
    { id: 'sql', label: 'SQL privileges', render: (body) => sqlTab(body, params && params[0] === 'sql' ? params[1] : null) },
  ], params && params[0])));
}
function rolesTab(body, open) {
  const reload = () => load(body, () => admin.get('/v2/security/roles'), (rows) => [
    toolbar(can('Secure') ? button([icon('plus'), 'New role'], () => roleEdit(null, reload), 'primary') : null, button('Refresh', reload)),
    table([{ key: 'Name', label: 'Role' }, { key: 'Description', label: 'Description' },
      { key: 'EscalationOnly', label: 'Escalation', render: (r) => r.EscalationOnly ? badge('Only', 'warn') : 'No' }], rows,
    { sortKey: 'Name', onRow: (r) => roleDetails(r.Name, reload), empty: 'No roles found.' })]);
  reload();
  if (open) roleDetails(open, reload);
}
async function roleDetails(name, reload) {
  const body = h('div', h('div.loading', 'Loading…')); const m = modal(name, body, { wide: true });
  try {
    const [role, owners] = await Promise.all([readRole(name), admin.get('/v2/security/role/owners', { name })]);
    const sql = h('div', loading());
    load(sql, () => sqlSummary(name), (rows) => [
      toolbar(button('Manage SQL privileges', () => navigate(`roles/sql/${encodeURIComponent(name)}`), 'small')),
      table([{ key: 'Namespace', label: 'Namespace' }, { key: 'Object', label: 'On' }, { key: 'Privileges', label: 'Privileges' }, { key: 'Via', label: 'Via' }], rows,
        { filter: false, empty: 'No SQL privileges.' })]);
    clear(body, toolbar(
      can('Secure') ? button('Edit', () => { m.close(); roleEdit({ ...role, Name: name }, reload); }) : null,
      can('Secure') ? h('button.danger', { disabled: name.startsWith('%'), title: name.startsWith('%') ? 'System roles cannot be deleted here' : 'Delete role', onclick: () => confirmAction({
        title: `Delete role ${name}`, message: 'This removes the role, its resource grants and its SQL privileges from every holder.',
        call: { method: 'DELETE', path: `/api/admin/v2/security/role${qp(name)}` }, danger: true, confirmLabel: 'Delete',
        confirmText: name, run: () => admin.del('/v2/security/role', { name }),
        verify: { read: () => readRole(name), expect: 'gone' }, done: 'Role deleted',
      }).then((ok) => { if (ok) { m.close(); reload(); } }) }, 'Delete') : null),
    h('h3', 'Resource grants'), table([{ key: 'Name', label: 'Resource' }, { key: 'Permissions', label: 'Permissions' }], role.Resources || [], { filter: false, empty: 'No resource grants.' }),
    h('h3', 'SQL privileges'), sql,
    h('h3', 'Users and roles holding this role'), table([{ key: 'Name', label: 'Name' }, { key: 'Type', label: 'Type' }, { key: 'AdminOption', label: 'Admin option' }], owners, { filter: false, empty: 'No holders found.' }),
    h('h3', 'Definition'), kv(role, { skip: ['Resources'] }));
  } catch (e) { clear(body, h('div.error-box', e.message)); }
}
function roleEdit(role, reload) {
  const fresh = !role; const initial = role || { Description: '', GrantedRoles: [], EscalationOnly: false, Resources: [] };
  const name = fresh ? h('input', { required: true, placeholder: 'Role name' }) : null;
  const form = objectForm(initial, EDIT); const preview = h('div');
  const build = () => { const n = fresh ? name.value.trim() : role.Name; if (!n) throw new Error('Role name is required.'); return { name: n, body: fresh ? form.value() : diff(role, form.value()) }; };
  modal(fresh ? 'New role' : `Edit ${role.Name}`, [fresh ? h('div.field', h('label', 'Name'), name) : null, form.el,
    toolbar(button('Preview API call', () => { try { const c = build(); clear(preview, apiCallPreview('PUT', `/api/admin/v2/security/role${qp(c.name)}`, c.body)); } catch (e) { toastError(e); } }, 'small')), preview],
  { wide: true, actions: [{ label: 'Cancel', onclick: () => {} }, { label: fresh ? 'Create' : 'Save changes', kind: 'primary', onclick: async () => {
    const c = build(); if (!Object.keys(c.body).length) { toast('No changes', 'warn'); return false; }
    await applyVerified({
      ...(!fresh ? { original: role, changes: c.body } : { expect: 'exists' }),
      read: () => readRole(c.name), write: () => admin.put('/v2/security/role', c.body, { name: c.name }),
    }, fresh ? 'Role created' : 'Role saved');
    reload();
  } }] });
}
function resourcesTab(body) {
  const reload = () => load(body, () => admin.get('/v2/security/resources'), (rows) => [
    toolbar(can('Secure') ? button([icon('plus'), 'New resource'], () => resourceEdit(null, reload), 'primary') : null, button('Refresh', reload)),
    table([{ key: 'Name', label: 'Resource' }, { key: 'Description', label: 'Description' }, { key: 'PublicPermission', label: 'Public permission' }, { key: 'ResourceType', label: 'Type' }], rows,
    { sortKey: 'Name', onRow: (r) => resourceDetails(r, reload), empty: 'No resources found.' })]);
  reload();
}
async function resourceDetails(row, reload) {
  const body = h('div', h('div.loading', 'Loading…')); const m = modal(row.Name, body);
  try {
    const r = await readResource(row.Name);
    clear(body, toolbar(can('Secure') ? button('Edit', () => { m.close(); resourceEdit({ ...r, Name: row.Name }, reload); }) : null,
      can('Secure') ? h('button.danger', { disabled: !row.AllowDelete, title: row.AllowDelete ? 'Delete resource' : 'This resource cannot be deleted', onclick: () => confirmAction({
        title: `Delete resource ${row.Name}`, message: 'This removes the resource and its permission grants.',
        call: { method: 'DELETE', path: `/api/admin/v2/security/resource${qp(row.Name)}` }, danger: true, confirmLabel: 'Delete',
        confirmText: row.Name, run: () => admin.del('/v2/security/resource', { name: row.Name }),
        verify: { read: () => readResource(row.Name), expect: 'gone' }, done: 'Resource deleted',
      }).then((ok) => { if (ok) { m.close(); reload(); } }) }, 'Delete') : null), kv(r));
  } catch (e) { clear(body, h('div.error-box', e.message)); }
}
function resourceEdit(resource, reload) {
  const fresh = !resource; const initial = resource || { Description: '', PublicPermission: '' };
  const name = fresh ? h('input', { required: true, placeholder: 'Resource name' }) : null;
  const form = objectForm(initial, [{ key: 'Description', type: 'textarea' }, { key: 'PublicPermission', label: 'Public permission', help: 'Letters such as R, W, U. The API cannot set “none”.' }]);
  const preview = h('div');
  const build = () => {
    const n = fresh ? name.value.trim() : resource.Name;
    if (!n) throw new Error('Resource name is required.');
    const body = fresh ? form.value() : diff(resource, form.value());
    // IRIS 2026.2 rejects an empty PublicPermission with a bare 400 (create and edit), see README notes.
    if ('PublicPermission' in body && !String(body.PublicPermission).trim()) {
      throw new Error('The SysAdmin API (IRIS 2026.2) cannot set an empty public permission. Enter at least one of R, W, U.');
    }
    return { name: n, body };
  };
  modal(fresh ? 'New resource' : `Edit ${resource.Name}`, [fresh ? h('div.field', h('label', 'Name'), name) : null, form.el,
    toolbar(button('Preview API call', () => { try { const c = build(); clear(preview, apiCallPreview('PUT', `/api/admin/v2/security/resource${qp(c.name)}`, c.body)); } catch (e) { toastError(e); } }, 'small')), preview],
  { actions: [{ label: 'Cancel', onclick: () => {} }, { label: fresh ? 'Create' : 'Save changes', kind: 'primary', onclick: async () => {
    const c = build(); if (!Object.keys(c.body).length) { toast('No changes', 'warn'); return false; }
    await applyVerified({
      ...(!fresh ? { original: resource, changes: c.body } : { expect: 'exists' }),
      read: () => readResource(c.name), write: () => admin.put('/v2/security/resource', c.body, { name: c.name }),
    }, fresh ? 'Resource created' : 'Resource saved');
    reload();
  } }] });
}
function matrixTab(body) {
  const picker = h('select'); const output = h('div');
  clear(body, h('p.muted', 'Effective resource permissions from role grants (including granted roles) and public permissions. SQL privileges are listed separately.'),
    toolbar(h('label', 'User ', picker), button('Calculate', () => calculate(picker.value, output), 'primary')), output);
  picker.addEventListener('change', () => calculate(picker.value, output));
  admin.get('/v2/security/users').then((rows) => {
    // Start with an ordinary account (not %All, not an internal user).
    const first = rows.find((u) => u.Name === 'demo_operator') || rows.find((u) => !/^(_|Admin$|SuperUser$|UnknownUser$|CSPSystem$|IAM$)/.test(u.Name)) || rows[0];
    clear(picker, rows.map((u) => h('option', { value: u.Name, selected: first && u.Name === first.Name }, u.Name)));
    if (first) calculate(first.Name, output);
  }).catch((e) => clear(output, h('div.error-box', e.message)));
}
async function calculate(name, output) {
  if (!name) return;
  await load(output, async () => {
    const [user, resources] = await Promise.all([admin.get('/v2/security/user', { name }), admin.get('/v2/security/resources')]);
    const direct = user.Roles || []; const escalation = user.EscalationRoles || [];
    const queue = [...new Set(direct)]; const roles = new Map();
    while (queue.length) {
      const role = queue.shift(); if (roles.has(role)) continue;
      const detail = await admin.get('/v2/security/role', { name: role }); roles.set(role, detail);
      (detail.GrantedRoles || []).forEach((r) => { if (!roles.has(r)) queue.push(r); });
    }
    return { direct, escalation, roles, resources };
  }, ({ direct, escalation, roles, resources }) => {
    const all = roles.has('%All');
    const grants = new Map();
    const add = (resName, perms, source) => {
      if (!grants.has(resName)) grants.set(resName, { Name: resName, R: [], W: [], U: [] });
      for (const p of ['R', 'W', 'U']) if ((perms || '').includes(p)) grants.get(resName)[p].push(source);
    };
    for (const [role, detail] of roles) for (const resource of detail.Resources || []) add(resource.Name, resource.Permissions, role);
    for (const r of resources) if (r.PublicPermission) add(r.Name, r.PublicPermission, 'Public');
    const cell = (sources) => (all ? badge('All (%All)', 'ok') : sources.length
      ? h('span', badge('Granted', sources.every((x) => x === 'Public') ? 'muted' : 'ok'), ` ${sources.join(', ')}`) : '—');
    return [
      all ? h('div.idea-note', h('strong', 'Full access: '), 'this user holds %All, which grants every permission on every resource.') : null,
      h('p', 'Direct roles: ', direct.join(', ') || 'none'),
      h('p', 'Escalation roles (only after the user escalates, not included below): ', escalation.join(', ') || 'none'),
      table([{ key: 'Name', label: 'Resource' }, ...['R', 'W', 'U'].map((p) => ({ key: p, label: p, render: (r) => cell(r[p]) }))],
        all ? resources.map((r) => ({ Name: r.Name, R: [], W: [], U: [] })) : [...grants.values()],
        { sortKey: 'Name', empty: 'No resource grants from these roles.' })];
  });
}
// Services this portal depends on: disabling them from here would cut off the session doing it.
const ESSENTIAL_SERVICES = new Set(['%Service_WebGateway']);
function servicesTab(body) {
  const reload = () => load(body, () => admin.get('/v2/security/services'), (rows) => [
    h('p.muted', '%Service_* entries: one per way of connecting (Web Gateway, SQL/objects, terminal, call-in, ECP). %Service_WebGateway cannot be disabled here: this UI runs through it.'),
    toolbar(button('Refresh', reload)),
    table([
      { key: 'Name', label: 'Service', render: (r) => h('div', h('strong', r.Name), h('div.muted.small', r.Description || '')) },
      { key: 'Enabled', label: 'State', render: (r) => badge(r.Enabled ? 'Enabled' : 'Disabled', r.Enabled ? 'ok' : 'muted') },
      { key: 'AuthenticationMethods', label: 'Authentication', render: (r) => (r.AuthenticationMethods || []).join(', ') || '—' },
      { key: 'Public', label: 'Public' },
      { key: 'AllowedConnections', label: 'Allowed IPs', render: (r) => (r.AllowedConnections || []).length ? r.AllowedConnections.join(', ') : 'any' },
      { key: 'TwoFactorEnabled', label: '2FA', render: (r) => (r.TwoFactorEnabled ? badge('On', 'ok') : '—') },
    ], rows, {
      sortKey: 'Name',
      actions: can('Secure') ? (r) => [ESSENTIAL_SERVICES.has(r.Name) && r.Enabled
        ? h('button.small', { disabled: true, title: 'This portal runs through the web gateway; disable it from the terminal if you really need to.' }, 'Disable')
        : button(r.Enabled ? 'Disable' : 'Enable', () => confirmAction({
          title: `${r.Enabled ? 'Disable' : 'Enable'} ${r.Name}`,
          message: r.Enabled ? 'Clients using this service will be refused until it is enabled again.' : 'Clients will be able to connect through this service.',
          call: { method: 'PUT', path: `/api/admin/v2/security/service?name=${encodeURIComponent(r.Name)}`, body: { Enabled: !r.Enabled } },
          danger: r.Enabled,
          run: () => admin.put('/v2/security/service', { Enabled: !r.Enabled }, { name: r.Name }),
          verify: { read: () => readService(r.Name), changes: { Enabled: !r.Enabled } },
          done: `${r.Name} ${r.Enabled ? 'disabled' : 'enabled'}`,
        }).then((ok) => ok && reload()), 'small')] : null,
    }),
  ]);
  reload();
}

// ---------- SQL privileges ----------
// IRIS 2026.2 lists object privileges as {Type, Object, Action, GrantedVia, …} and column privileges as
// {Column, Action, …}, not with the Name/Privilege fields the OpenAPI spec documents. A grant on a SCHEMA is
// not listed as such: each table of the schema shows it with GrantedVia "Schema Privilege".
const OBJECT_ACTIONS = {
  TABLE: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', '%ALTER'],
  VIEW: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', '%ALTER'],
  'STORED PROCEDURE': ['EXECUTE', '%ALTER'],
  SCHEMA: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'REFERENCES', 'EXECUTE', '%ALTER'],
  CUBES: ['SELECT'],
  'ML CONFIGURATION': ['USE'],
  'FOREIGN SERVER': ['USE'],
};
const COLUMN_ACTIONS = ['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'];
// The SQL admin privileges of IRIS 2026.2 (the set SuperUser holds). The API grants one per call.
const ADMIN_PRIVILEGES = ['%ALTER_ML_CONFIGURATION', '%ALTER_TABLE', '%ALTER_VIEW', '%BUILD_INDEX', '%CANCEL_QUERY',
  '%CREATE_FUNCTION', '%CREATE_METHOD', '%CREATE_ML_CONFIGURATION', '%CREATE_PROCEDURE', '%CREATE_QUERY', '%CREATE_TABLE',
  '%CREATE_TRIGGER', '%CREATE_VIEW', '%DROP_FUNCTION', '%DROP_METHOD', '%DROP_ML_CONFIGURATION', '%DROP_PROCEDURE',
  '%DROP_QUERY', '%DROP_TABLE', '%DROP_TRIGGER', '%DROP_UNOWNED', '%DROP_VIEW', '%MANAGE_FOREIGN_SERVER', '%MANAGE_MODEL',
  '%NOCHECK', '%NOINDEX', '%NOJOURN', '%NOLOCK', '%NOTRIGGER', '%USE_EMBEDDING', '%USE_MODEL'];
const KINDS = [['sql-privilege', 'Object privileges (table, view, procedure, schema, …)'], ['sql-admin-privilege', 'Admin privileges (%CREATE_TABLE, …)'], ['sql-column-privilege', 'Column privileges']];
const DIRECT = 'Direct'; const VIA_SCHEMA = 'Schema Privilege';
const upper = (s) => String(s || '').toUpperCase();

// `api` is the endpoint family (sql-privilege, sql-admin-privilege, sql-column-privilege), `q` its query parameters.
const listSql = (api, q) => admin.get(`/v2/security/${api}s`, {
  grantee: q.grantee, namespace: q.namespace, object: api === 'sql-column-privilege' ? q.object : undefined, maxRows: 10000,
});
/** The POST that grants or revokes one privilege: its path for the preview and the call itself. */
const sqlCall = (api, verb, q) => ({
  path: `/api/admin/v2/security/${api}/${verb}${buildQuery(q)}`, run: () => admin.post(`/v2/security/${api}/${verb}`, {}, q),
});
/** "SELECT on Sample.Person", "UPDATE on Sample.Person (Name)", "%CREATE_TABLE". */
const sqlLabel = (api, q) => (api === 'sql-admin-privilege' ? q.privilege
  : `${q.action} on ${q.type === 'SCHEMA' ? 'schema ' : ''}${q.object}${api === 'sql-column-privilege' ? ` (${q.column})` : ''}`);

/**
 * Read-back for verified changes: {label: held} for each privilege in `qs` (same grantee and namespace).
 * Only direct grants count, so a revoke is not reported as failed while a role still grants the same privilege.
 */
const heldSql = (api, qs) => async () => {
  const rows = await listSql(api, qs[0]);
  const holds = (q) => rows.some((r) => {
    if (q.withGrant && !r.GrantOption) return false;
    if (api === 'sql-admin-privilege') return r.GrantedVia === DIRECT && r.Privilege === q.privilege;
    if (r.Action !== q.action) return false;
    if (api === 'sql-column-privilege') return r.GrantedVia === DIRECT && upper(r.Column) === upper(q.column);
    if (q.type === 'SCHEMA') return r.GrantedVia === VIA_SCHEMA && upper(r.Object).startsWith(`${upper(q.object)}.`);
    return r.GrantedVia === DIRECT && r.Type === q.type && upper(r.Object) === upper(q.object);
  });
  return Object.fromEntries(qs.map((q) => [sqlLabel(api, q), holds(q)]));
};

function revokeSql(api, q, reload) {
  const call = sqlCall(api, 'revoke', q); const what = sqlLabel(api, q);
  return confirmAction({
    title: `Revoke ${what}`, message: `${q.grantee} loses ${what} in namespace ${q.namespace}. The same privilege held through a role is not affected.`,
    call: { method: 'POST', path: call.path }, danger: true, confirmLabel: 'Revoke', run: call.run,
    verify: { read: heldSql(api, [q]), changes: { [what]: false } }, done: `${what} revoked`,
  }).then((ok) => ok && reload());
}

/**
 * Users, roles and namespaces for the pickers (the %ALL pseudo-namespace holds no SQL objects).
 * Listing namespaces needs Manage: without it `namespaces` is null and the pickers take a typed name.
 */
async function sqlChoices() {
  let namespaceError = null;
  const [users, roles, namespaces] = await Promise.all([admin.get('/v2/security/users'), admin.get('/v2/security/roles'),
    admin.get('/v2/namespaces').catch((e) => { namespaceError = e; return null; })]);
  return { users: users.map((u) => u.Name), roles: roles.map((r) => r.Name), namespaces: namespaces && namespaces.map((n) => n.Name).filter((n) => n !== '%ALL'), namespaceError };
}
/** Fills the pickers; returns the namespace control, which becomes a text input when namespaces cannot be listed. */
function fillPickers(grantee, namespace, choices, selected = {}) {
  const who = selected.grantee || choices.roles.find((r) => !r.startsWith('%')) || choices.users[0];
  clear(grantee, [['Roles', choices.roles], ['Users', choices.users]].map(([label, names]) =>
    h('optgroup', { label }, names.map((n) => h('option', { value: n, selected: n === who }, n)))));
  if (!choices.namespaces) {
    const input = h('input', { id: namespace.id || null, 'aria-label': 'Namespace', value: selected.namespace || 'USER', autocomplete: 'off',
      title: `Namespaces could not be listed (${choices.namespaceError.message}): type the name.` });
    namespace.replaceWith(input);
    return input;
  }
  const ns = choices.namespaces.includes(selected.namespace) ? selected.namespace : choices.namespaces.includes('USER') ? 'USER' : choices.namespaces[0];
  clear(namespace, choices.namespaces.map((n) => h('option', { value: n, selected: n === ns }, n)));
  return namespace;
}
const nsValue = (el) => el.value.trim().toUpperCase();

function sqlTab(body, open) {
  const grantee = h('select', { 'aria-label': 'Grantee' }); let namespace = h('select', { 'aria-label': 'Namespace' }); const results = h('div');
  // Each selection renders into its own node: a late answer for an earlier selection lands in a detached node.
  const show = () => { const node = h('div'); clear(results, node); sqlPrivileges(node, { grantee: grantee.value, namespace: nsValue(namespace) }); };
  const pick = (who, ns) => { grantee.value = who; namespace.value = ns; show(); };
  grantee.addEventListener('change', show);
  clear(body, h('p.muted', 'SQL privileges a user or role holds in one namespace: object privileges on tables, views, procedures and schemas, and admin privileges such as %CREATE_TABLE.'),
    toolbar(h('label', 'Grantee ', grantee), h('label', 'Namespace ', namespace),
      can('Secure') ? button([icon('plus'), 'Grant…'], () => grantSql({ grantee: grantee.value, namespace: nsValue(namespace) }, pick), 'primary') : null), results);
  clear(results, loading());
  sqlChoices().then((choices) => {
    namespace = fillPickers(grantee, namespace, choices, { grantee: open });
    namespace.addEventListener('change', show);
    show();
  }).catch((e) => clear(results, errorBox(e)));
}

function sqlPrivileges(container, q) {
  // Reloads (retry, after a revoke) also get a fresh node, so only the newest one stays visible.
  const node = h('div'); clear(container, node);
  const reload = () => sqlPrivileges(container, q);
  const secure = can('Secure');
  return load(node, () => Promise.all([listSql('sql-privilege', q), listSql('sql-admin-privilege', q)]), ([objects, admins]) => [
    h('h3', 'Object privileges'),
    table([
      { key: 'Type', label: 'Type' }, { key: 'Object', label: 'Object' },
      { key: 'Action', label: 'Privilege', render: (r) => r.Action || badge('column-level', 'muted') },
      { key: 'GrantedVia', label: 'Via' }, { key: 'GrantedBy', label: 'Grantor' }, { key: 'GrantOption', label: 'Grant option' },
    ], objects, {
      sortKey: 'Object', empty: 'No object privileges.',
      actions: (r) => [
        r.HasColumnPriv ? button('Columns', () => columnPrivileges({ ...q, type: r.Type, object: r.Object }), 'small') : null,
        // A schema grant is revoked on the schema; privileges through roles or ownership are revoked where they come from.
        secure && r.Action && (r.GrantedVia === DIRECT || r.GrantedVia === VIA_SCHEMA) ? button(r.GrantedVia === DIRECT ? 'Revoke' : 'Revoke schema grant', () => revokeSql('sql-privilege',
          r.GrantedVia === DIRECT ? { ...q, type: r.Type, object: r.Object, action: r.Action } : { ...q, type: 'SCHEMA', object: r.Object.split('.')[0], action: r.Action }, reload), 'small') : null,
      ],
    }),
    h('h3', 'Admin privileges'),
    table([{ key: 'Privilege', label: 'Privilege' }, { key: 'GrantedVia', label: 'Via' }, { key: 'GrantOption', label: 'Grant option' }], admins, {
      sortKey: 'Privilege', filter: false, empty: 'No admin privileges.',
      actions: secure ? (r) => (r.GrantedVia === DIRECT ? button('Revoke', () => revokeSql('sql-admin-privilege', { ...q, privilege: r.Privilege }, reload), 'small') : null) : null,
    }),
  ]);
}

function columnPrivileges(q) {
  const body = h('div');
  const reload = () => load(body, () => listSql('sql-column-privilege', q), (rows) => table([
    { key: 'Column', label: 'Column' }, { key: 'Action', label: 'Privilege' }, { key: 'GrantedVia', label: 'Via' }, { key: 'GrantedBy', label: 'Grantor' }, { key: 'GrantOption', label: 'Grant option' },
  ], rows, {
    sortKey: 'Column', filter: false, empty: 'No column privileges.',
    actions: can('Secure') ? (r) => (r.GrantedVia === DIRECT ? button('Revoke', () => revokeSql('sql-column-privilege', { ...q, column: r.Column, action: r.Action }, reload), 'small') : null) : null,
  }));
  modal(`Column privileges of ${q.grantee} on ${q.object}`, body, { wide: true });
  reload();
}

async function grantSql(initial, pick) {
  let choices;
  try { choices = await sqlChoices(); } catch (e) { toastError(e); return; }
  const grantee = h('select#sql-grantee');
  const namespace = fillPickers(grantee, h('select#sql-namespace'), choices, initial);
  const kind = h('select#sql-kind', KINDS.map(([v, l]) => h('option', { value: v }, l)));
  const type = h('select#sql-type');
  const object = h('input#sql-object', { list: 'sql-objects', placeholder: 'Schema.Table', autocomplete: 'off' });
  const objects = h('datalist#sql-objects');
  const column = h('input#sql-column', { placeholder: 'Column name', autocomplete: 'off' });
  const withGrant = h('input#sql-grant-option', { type: 'checkbox' });
  const privileges = h('div.form-grid.sql-grant-privileges'); const preview = h('div');
  const field = (label, input, help) => h('div.field', h('label', { for: input.id }, label), input, help ? h('small.muted', help) : null);
  const typeField = field('Object type', type);
  const objectField = field('Object', object, 'Pick from the list or type a name. The list shows the objects of this namespace you hold privileges on.');
  const columnField = field('Column', column, 'IRIS answers OK but records nothing for an unknown column or when the grantee already holds the privilege on the whole table; the read-back shows it.');
  let boxes = [];

  const drawPrivileges = () => {
    const names = kind.value === 'sql-admin-privilege' ? ADMIN_PRIVILEGES : kind.value === 'sql-column-privilege' ? COLUMN_ACTIONS : OBJECT_ACTIONS[type.value];
    boxes = names.map((n) => [n, h('input', { type: 'checkbox' })]);
    clear(privileges, boxes.map(([n, input]) => h('label.field.check', input, ` ${n}`)));
    clear(preview);
  };
  // No SysAdmin endpoint lists tables: the signed-in account's own privileges stand in as the catalog
  // (for %All holders that is every object of the namespace).
  const catalogs = new Map();
  const suggest = async () => {
    const ns = nsValue(namespace); const t = type.value; const me = session.info && session.info.username;
    if (!me || kind.value === 'sql-admin-privilege') return;
    if (!catalogs.has(ns)) catalogs.set(ns, admin.get('/v2/security/sql-privileges', { grantee: me, namespace: ns, maxRows: 100000 }).catch(() => []));
    const rows = await catalogs.get(ns);
    if (ns !== nsValue(namespace) || t !== type.value) return; // the pickers changed meanwhile
    const names = t === 'SCHEMA' ? rows.filter((r) => r.Type === 'TABLE' || r.Type === 'VIEW').map((r) => r.Object.split('.')[0]) : rows.filter((r) => r.Type === t).map((r) => r.Object);
    clear(objects, [...new Set(names)].sort().map((n) => h('option', { value: n })));
  };
  const drawKind = () => {
    const types = kind.value === 'sql-column-privilege' ? ['TABLE', 'VIEW'] : Object.keys(OBJECT_ACTIONS);
    const keep = types.includes(type.value) ? type.value : 'TABLE';
    clear(type, types.map((t) => h('option', { value: t, selected: t === keep }, t)));
    typeField.style.display = objectField.style.display = kind.value === 'sql-admin-privilege' ? 'none' : '';
    columnField.style.display = kind.value === 'sql-column-privilege' ? '' : 'none';
    drawPrivileges(); suggest();
  };
  kind.addEventListener('change', drawKind);
  type.addEventListener('change', () => { drawPrivileges(); suggest(); });
  namespace.addEventListener('change', suggest);

  const build = () => {
    const api = kind.value; const base = { namespace: nsValue(namespace), grantee: grantee.value };
    if (api !== 'sql-admin-privilege') {
      Object.assign(base, { type: type.value, object: object.value.trim() });
      if (!base.object) throw new Error('Enter the object name.');
    }
    if (api === 'sql-column-privilege') {
      base.column = column.value.trim();
      if (!base.column) throw new Error('Enter the column name.');
    }
    if (withGrant.checked) base.withGrant = 1;
    const picked = boxes.filter(([, input]) => input.checked).map(([n]) => n);
    if (!picked.length) throw new Error('Tick at least one privilege.');
    // One call per privilege: the admin-privilege endpoint rejects lists and the others do not document them.
    return { api, qs: picked.map((p) => ({ ...base, [api === 'sql-admin-privilege' ? 'privilege' : 'action']: p })) };
  };
  modal('Grant SQL privileges', [
    h('div.form-grid', field('Grantee', grantee), field('Namespace', namespace), h('div.field.span', h('label', { for: kind.id }, 'What to grant'), kind),
      typeField, objectField, columnField, h('label.field.check', withGrant, ' With grant option (may grant it to others)')),
    objects, h('h3', 'Privileges'), privileges,
    toolbar(button('Preview API calls', () => {
      try { const c = build(); clear(preview, c.qs.map((q) => apiCallPreview('POST', sqlCall(c.api, 'grant', q).path))); } catch (e) { toastError(e); }
    }, 'small')), preview,
  ], { wide: true, actions: [{ label: 'Cancel', onclick: () => {} }, { label: 'Grant', kind: 'primary', onclick: async () => {
    const c = build();
    await applyVerified({
      read: heldSql(c.api, c.qs),
      changes: Object.fromEntries(c.qs.map((q) => [sqlLabel(c.api, q), true])),
      write: async () => { for (const q of c.qs) await sqlCall(c.api, 'grant', q).run(); },
    }, c.qs.length > 1 ? `${c.qs.length} privileges granted to ${c.qs[0].grantee}` : `${sqlLabel(c.api, c.qs[0])} granted to ${c.qs[0].grantee}`);
    pick(c.qs[0].grantee, c.qs[0].namespace);
  } }] });
  drawKind();
}

/**
 * Compact summary for the role details: SQL privileges of `grantee` in every namespace, one row per object.
 * Owner privileges on a few system procedures, which every account lists, are left out.
 */
async function sqlSummary(grantee) {
  const { namespaces, namespaceError } = await sqlChoices();
  if (!namespaces) throw namespaceError;
  const perNamespace = await Promise.all(namespaces.map(async (namespace) => {
    const [objects, admins] = await Promise.all([listSql('sql-privilege', { grantee, namespace }), listSql('sql-admin-privilege', { grantee, namespace })]);
    const rows = new Map();
    for (const r of objects.filter((x) => x.GrantedVia !== 'Owner Privilege')) {
      const key = `${r.Type} ${r.Object} ${r.GrantedVia}`;
      if (!rows.has(key)) rows.set(key, { Namespace: namespace, Object: `${r.Object} (${r.Type.toLowerCase()})`, Privileges: [], Via: r.GrantedVia });
      rows.get(key).Privileges.push(r.Action || 'column-level');
    }
    if (admins.length) rows.set('admin', { Namespace: namespace, Object: 'Admin privileges', Privileges: admins.map((r) => r.Privilege), Via: [...new Set(admins.map((r) => r.GrantedVia))].join(', ') });
    return [...rows.values()];
  }));
  return perNamespace.flat();
}
