import { admin, ext, findInList, waitAsync, ApiError } from '../api.js';
import { can } from '../app.js';
import { h, page, table, tabs, load, modal, confirmAction, applyVerified, objectForm, diff, kv, badge, fmtBytes, button, toolbar, clear, errorBox, toast, toastError, apiCallPreview, icon, loading } from '../ui.js';
import { RECORD_TYPES, PAGE_SIZE, conditions, recordsQuery, refine, nextOffset, globalRef, recordValues } from '../journal.js';

// Databases this deck never deletes, dismounts or makes read-only.
const PROTECTED = new Set(['IRISSYS', 'IRISLIB', 'IRISTEMP', 'IRISAUDIT', 'IRISSECURITY', 'IRISLOCALDATA', 'IRISMETRICS', 'ENSLIB', 'IPM', 'HSLIB']);
// Namespaces this deck never deletes, besides those serving the portal itself (PORTAL_APP).
const CORE_NAMESPACES = new Set(['%SYS', '%ALL', 'USER']);
const PORTAL_APP = /^\/admindeck(?:\/|$)|^\/api\/admin(?:\/|$)|^\/csp\/sys(?:\/|$)/i;
// Database and namespace names are stored upper-case; new ones start with a letter.
const NEW_NAME = /^[A-Z][A-Z0-9_-]{0,63}$/;
const DEFAULT_USES = [['Globals', 'globals'], ['Routines', 'routines'], ['TempGlobals', 'temporary globals'], ['Library', 'library'], ['SysGlobals', 'system globals'], ['SysRoutines', 'system routines']];
const MAPPINGS = [
  { id: 'global', label: 'Global', help: 'Global name without ^, optionally with subscripts: Orders or Orders("2024"). A subscripted mapping also maps the rest of the global to the default database.' },
  { id: 'routine', label: 'Routine', help: 'Routine name or prefix*, with an optional type suffix: Util* or MyRoutine_MAC.' },
  { id: 'package', label: 'Package', help: 'Class package name: MyApp.Data' },
];
// Space operations run as background tasks (202); results show in the task view.
const SPACE_OPS = [
  { id: 'modify-size', label: 'Expand', field: 'Size', fieldLabel: 'New size (MB)', priv: 'Manage', message: 'Grow the database file to the given total size now, instead of waiting for automatic expansion.' },
  { id: 'compact', label: 'Compact', field: 'TargetFreeSpace', fieldLabel: 'Target free space (MB)', priv: 'Operate', message: 'Move data towards the start of the file so free space collects at the end. Adds I/O load while it runs.' },
  { id: 'truncate', label: 'Truncate', field: 'TargetSize', fieldLabel: 'Target size (MB)', priv: 'Operate', message: 'Return free space at the end of the file to the file system. 0 releases all of it.' },
];

const pathWith = (path, query) => `/api/admin${path}?${new URLSearchParams(query)}`;
const taskId = (result) => typeof result === 'string' ? result : result?.GUID || result?.Id || result?.id || result?.Task?.GUID;
const taskDone = (task) => /complete|completed|done|finished|failed|cancelled|canceled|error/i.test(String(task?.State || ''));
const readDevice = (name) => admin.get('/v2/device', { name });
const readDeviceSettings = () => admin.get('/v2/device/settings');
const readDbDir = (dir) => admin.get('/v2/database-dir', { dir });
const readDbConfig = (name) => admin.get('/v2/database', { name });
const readNamespace = (name) => admin.get('/v2/namespace', { name });
const readMapping = (kind, namespace, name) => admin.get(`/v2/namespace/${kind.id}-mapping`, { namespace, name });
const notFound = (e) => e.status === 404 || /does ?n[o']t exist/i.test(e.message || '');
const exists = (read) => read().then(() => true, (e) => { if (notFound(e)) return false; throw e; });
const selectOptions = (names, current) => [...new Set([...names, current].filter(Boolean))].sort();
async function readDatabaseState(dir) {
  const row = await findInList('/v2/database-dirs', {}, 'Directory', dir);
  return { Mounted: /^mounted(?:\/|$)/i.test(String(row.Status || '')) };
}
function settingsFields(settings, changes) {
  return Object.fromEntries(Object.entries(changes).map(([group, fields]) =>
    [group, Object.fromEntries(Object.keys(fields).map((key) => [key, settings[group]?.[key]]))]));
}
// Database resources (%DB_*) for the resource picker; empty when the user may not list resources.
const dbResources = () => admin.get('/v2/security/resources').then((rows) => rows.map((r) => r.Name).filter((n) => /^%DB_/i.test(n)), () => []);

export default async function render(el, params) {
  el.append(page('Databases & system', null,
    tabs([
      { id: 'databases', label: 'Databases', render: databasesTab },
      { id: 'namespaces', label: 'Namespaces', render: namespacesTab },
      { id: 'journal', label: 'Journal', render: journalTab },
      { id: 'backups', label: 'Backups', render: backupsTab },
      { id: 'devices', label: 'Devices', render: devicesTab },
      { id: 'license', label: 'License', render: licenseTab },
      { id: 'jobs', label: 'Background jobs', render: jobsTab },
    ], params[0])));
}

function databasesTab(body) {
  const reload = () => load(body, async () => {
    const [local, config] = await Promise.all([admin.get('/v2/database-dirs'), admin.get('/v2/databases')]);
    const cfg = Array.isArray(config) ? config : [];
    const locals = Array.isArray(local) ? local : local?.Directory ? [local] : [];
    const dirs = new Set(locals.map((r) => r.Directory));
    return [...locals.map((r) => {
      const match = cfg.find((c) => c.Directory === r.Directory);
      return { ...match, ...r, Name: match?.Name || r.Name || r.Directory?.split('/').filter(Boolean).at(-1), Local: true, Configured: !!match };
    }), ...cfg.filter((r) => !dirs.has(r.Directory)).map((r) => ({ ...r, Local: false, Configured: true }))];
  }, (rows) => [toolbar(
    can('Manage') ? button([icon('plus'), 'New database'], () => databaseCreate(rows, reload).catch(toastError), 'primary') : null,
    button('Refresh', reload)), table([
    { key: 'Name', label: 'Database' }, { key: 'Directory', label: 'Directory' },
    { key: 'Size', label: 'Size', render: (r) => r.Size === undefined ? '—' : `${r.Size} MB` },
    { key: 'Status', label: 'Status', render: (r) => badge(r.Status || '—', /mount/i.test(r.Status || '') ? 'ok' : 'warn') },
    { key: 'ReadOnly', label: 'Read-only', render: (r) => (r.ReadOnly || /\/R$/.test(String(r.Status || '')) ? badge('Yes', 'warn') : 'No') },
    { key: 'Encrypted', label: 'Encrypted', render: (r) => r.Encrypted ? badge('Yes', 'ok') : 'No' },
  ], rows, { empty: 'No local databases.', onRow: (r) => databaseDetails(r, reload),
    actions: (r) => [button('Details', () => databaseDetails(r, reload), 'small')],
  })]);
  reload();
}

// Where databases are used: namespace defaults and global/routine/package mappings of every namespace.
async function databaseUsage() {
  const namespaces = await admin.get('/v2/namespaces');
  const uses = [];
  for (const n of namespaces) for (const [key, what] of DEFAULT_USES) if (n[key]) uses.push({ Database: n[key], Namespace: n.Name, Use: `Default ${what}` });
  await Promise.all(namespaces.flatMap((n) => MAPPINGS.map(async (kind) => {
    for (const r of await admin.get(`/v2/namespace/${kind.id}-mappings`, { namespace: n.Name })) {
      uses.push({ Database: r.Database, Namespace: n.Name, Use: `${kind.label} mapping ${r.Name}` });
      if (r.LockDatabase && r.LockDatabase !== r.Database) uses.push({ Database: r.LockDatabase, Namespace: n.Name, Use: `Lock database of ${r.Name}` });
    }
  })));
  return uses;
}

async function databaseInfo(row) {
  // database-dir/info runs as a background task (202 + async-result)
  let info = await admin.post('/v2/database-dir/info', {}, { dir: row.Directory });
  if (info && info.GUID && info.State === 'Queued') {
    const task = await waitAsync(info.GUID, { interval: 700 });
    if (/fail|error/i.test(task.State)) throw new Error(task.FailureReason || `Task ${task.State}`);
    info = task.Result || {};
  }
  return info;
}

async function databaseDetails(row, reload) {
  const content = h('div', h('div.loading', 'Loading…'));
  const m = modal(row.Name || row.Directory, content, { wide: true });
  try {
    // Usage needs Manage (namespace list): without it the other details and operations still work, only Delete is disabled.
    // Runtime information comes from a background task whose result not every account may read: shown when available.
    let usageError = null; let infoError = null;
    const [info, settings, usage] = await Promise.all([row.Local ? databaseInfo(row).catch((e) => { infoError = e; return null; }) : null, row.Local ? readDbDir(row.Directory) : null,
      databaseUsage().catch((e) => { usageError = e; return null; })]);
    const mounted = /mount/i.test(String(row.Status || '')) && !/dismount/i.test(String(row.Status || ''));
    const name = String(row.Name || '').toUpperCase();
    const protectedDb = PROTECTED.has(name) || PROTECTED.has(String(row.Directory || '').split('/').filter(Boolean).at(-1)?.toUpperCase());
    const used = (usage || []).filter((u) => String(u.Database).toUpperCase() === name);
    const blocked = protectedDb ? 'System databases cannot be deleted here.'
      : !usage ? `Usage could not be checked (${usageError.message}): deletion is disabled.`
      : used.length ? `Used by ${[...new Set(used.map((u) => u.Namespace))].join(', ')}: remove it from those namespaces first.` : '';
    const done = (ok) => { if (ok) { m.close(); reload(); } };
    clear(content, toolbar(
      can('Operate') && row.Local ? [
        !mounted ? button('Mount', () => databaseAction(row, 'mount', reload), 'primary') : null,
        !mounted ? null : protectedDb ? h('span.muted.small', 'Core database: dismount blocked') : button('Dismount', () => databaseAction(row, 'dismount', reload), 'danger'),
        button('Integrity check', () => integrityCheck(row))] : null,
      can('Manage') && row.Local && row.Configured ? button('Edit', () => databaseEdit(row, settings, protectedDb).then(done, toastError)) : null,
      row.Local && mounted ? SPACE_OPS.filter((op) => can(op.priv)).map((op) => button(op.label, () => { m.close(); spaceTask(row, op, reload); })) : null,
      can('Manage') ? h('button.danger', { disabled: !!blocked, title: blocked || 'Delete database', onclick: () => databaseDelete(row).then(done) }, 'Delete') : null),
      blocked && can('Manage') && !protectedDb ? h('p.muted.small', blocked) : null,
      h('h3', 'Used by'), usage ? table([{ key: 'Namespace', label: 'Namespace' }, { key: 'Use', label: 'Use' }], used, { filter: false, empty: 'Not used by any namespace.' })
        : h('p.muted.small', `Usage could not be checked: ${usageError.message}`),
      settings ? [h('h3', 'Settings'), kv(settings)] : null,
      h('h3', row.Local ? 'Local database' : 'Database definition'), kv(row, { skip: ['Local', 'Configured'] }),
      info ? [h('h3', 'Runtime information'), kv(info)] : infoError ? [h('h3', 'Runtime information'), h('p.muted.small', `Could not be read: ${infoError.message}`)] : null);
  } catch (e) { clear(content, errorBox(e)); }
}

function databaseAction(row, action, reload) {
  const path = `/v2/database-dir/${action}`;
  return confirmAction({ title: `${action === 'mount' ? 'Mount' : 'Dismount'} ${row.Name}`,
    message: action === 'dismount' ? 'Applications using this database will lose access until it is mounted again.' : 'The database will become available to applications.',
    call: { method: 'POST', path: pathWith(path, { dir: row.Directory }), body: {} }, danger: action === 'dismount',
    run: () => admin.post(path, {}, { dir: row.Directory }), done: `Database ${action}ed`,
    verify: { read: () => readDatabaseState(row.Directory), changes: { Mounted: action === 'mount' } },
  }).then((ok) => ok && reload());
}

// Directory for a new database: relative names go under the manager directory; always ends with a separator.
function databaseDirectory(value, mgr) {
  let dir = value.trim();
  if (!dir) throw new Error('Directory is required.');
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(dir)) dir = `${mgr}${dir}`;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? dir : `${dir}${sep}`;
}

// A database is two objects: the IRIS.DAT file (POST /v2/database-dir) and its named definition (PUT /v2/database).
async function databaseCreate(rows, reload) {
  const mgr = rows.find((r) => r.Name === 'IRISSYS')?.Directory || '';
  const resources = selectOptions(await dbResources(), '%DB_%DEFAULT');
  const nameInput = h('input', { required: true, placeholder: 'MYAPPDATA' });
  const dirInput = h('input', { required: true, placeholder: `${mgr}myappdata/` });
  let dirEdited = false;
  dirInput.addEventListener('input', () => { dirEdited = true; });
  nameInput.addEventListener('input', () => { if (!dirEdited) dirInput.value = nameInput.value.trim() ? `${mgr}${nameInput.value.trim().toLowerCase()}/` : ''; });
  const form = objectForm({ Size: 1, GlobalJournalState: true, ResourceName: '%DB_%DEFAULT' }, [
    { key: 'Size', label: 'Initial size (MB)', type: 'number' },
    // Sent explicitly: the API creates databases without journaling when it is left out.
    { key: 'GlobalJournalState', label: 'Journal globals', type: 'bool' },
    { key: 'ResourceName', label: 'Resource', type: 'select', options: resources },
  ]);
  const preview = h('div');
  const build = () => {
    const name = nameInput.value.trim().toUpperCase();
    if (!NEW_NAME.test(name)) throw new Error('Name: a letter followed by letters, digits, _ or - (up to 64).');
    const dir = databaseDirectory(dirInput.value, mgr);
    return { name, dir, file: { Directory: dir, ...form.value() }, definition: { Directory: dir } };
  };
  modal('New database', [
    h('div.form-grid', h('div.field', h('label', 'Name'), nameInput), h('div.field', h('label', 'Directory'), dirInput, h('small.muted', 'Created if missing; must not already hold a database.'))),
    form.el,
    toolbar(button('Preview API calls', () => { try { const c = build(); clear(preview, apiCallPreview('POST', '/api/admin/v2/database-dir', c.file), apiCallPreview('PUT', pathWith('/v2/database', { name: c.name }), c.definition)); } catch (e) { toastError(e); } }, 'small')), preview,
  ], { wide: true, actions: [{ label: 'Cancel', onclick: () => {} }, { label: 'Create', kind: 'primary', onclick: async () => {
    const c = build();
    if (await exists(() => readDbConfig(c.name))) throw new Error(`Database ${c.name} already exists.`);
    // POST on a directory that already holds a database fails with a misleading "must be dismounted" error.
    if (await exists(() => readDbDir(c.dir))) throw new Error(`${c.dir} already holds a database. Choose another directory.`);
    await applyVerified({ read: () => readDbDir(c.dir), changes: c.file, write: () => admin.post('/v2/database-dir', c.file) }, 'Database file created');
    try {
      await applyVerified({ read: () => readDbConfig(c.name), changes: c.definition, write: () => admin.put('/v2/database', c.definition, { name: c.name }) }, `Database ${c.name} created`);
    } catch (e) {
      const cleanup = await removeOrphanFile(c);
      reload();
      throw new Error(`${e.message} ${cleanup}`);
    }
    reload();
  } }] });
}

// The definition step failed, possibly after IRIS committed it. The new file is removed only when it is certainly
// an orphan (no definition, no other database on the directory) and its removal is read back. Returns what happened.
async function removeOrphanFile(c) {
  const sameDir = (d) => String(d || '').replace(/[\\/]+$/, '') === c.dir.replace(/[\\/]+$/, '');
  try {
    if (await exists(() => readDbConfig(c.name))) return `(the definition ${c.name} exists anyway: check it under Databases before retrying)`;
    const users = (await admin.get('/v2/databases')).filter((d) => sameDir(d.Directory)).map((d) => d.Name);
    if (users.length) return `(the new file in ${c.dir} was kept: ${users.join(', ')} refer to that directory)`;
  } catch (e) {
    return `(could not check whether the definition exists: ${e.message}; the new file in ${c.dir} was kept)`;
  }
  const failed = await admin.del('/v2/database-dir', { dir: c.dir }).then(() => null, (e) => e);
  try {
    if (!await exists(() => readDbDir(c.dir))) return '(the new database file was removed again; read back: gone)';
  } catch (e) {
    return `(removing the new file in ${c.dir} could not be verified: ${e.message}; check it under Databases)`;
  }
  return `(the new database file in ${c.dir} is still there${failed ? `: ${failed.message}` : ''}; delete it under Databases)`;
}

// Settings live on two objects: the database file (size, journaling, read-only, resource) and the definition.
async function databaseEdit(row, settings, protectedDb) {
  const [resources, definition] = await Promise.all([dbResources(), readDbConfig(row.Name)]);
  const fileForm = objectForm(settings, [
    { key: 'MaxSize', label: 'Maximum size (MB)', type: 'number', help: '0 = unlimited' },
    { key: 'ExpansionSize', label: 'Expansion size (MB)', type: 'number', help: '0 = system default (recommended)' },
    { key: 'GlobalJournalState', label: 'Journal globals', type: 'bool' },
    { key: 'ReadOnly', label: 'Read-only', type: 'bool', readonly: protectedDb, help: protectedDb ? 'Not changeable for system databases here.' : null },
    { key: 'ResourceName', label: 'Resource', type: 'select', options: selectOptions(resources, settings.ResourceName) },
  ]);
  const defForm = objectForm(definition, [{ key: 'MountRequired', label: 'Mount required at startup', type: 'bool' }]);
  const preview = h('div');
  const build = () => ({ file: diff(settings, fileForm.value()), definition: diff(definition, defForm.value()) });
  const filePath = pathWith('/v2/database-dir', { dir: row.Directory });
  const defPath = pathWith('/v2/database', { name: row.Name });
  return new Promise((resolve) => modal(`Edit ${row.Name}`, [fileForm.el, defForm.el,
    toolbar(button('Preview API calls', () => { try { const c = build(); clear(preview, Object.keys(c.file).length ? apiCallPreview('PUT', filePath, c.file) : null, Object.keys(c.definition).length ? apiCallPreview('PUT', defPath, c.definition) : null, !Object.keys({ ...c.file, ...c.definition }).length ? h('p.muted', 'No changes.') : null); } catch (e) { toastError(e); } }, 'small')), preview,
  ], { wide: true, onClose: () => resolve(false), actions: [{ label: 'Cancel', onclick: () => {} }, { label: 'Save changes', kind: 'primary', onclick: async () => {
    const c = build();
    if (!Object.keys({ ...c.file, ...c.definition }).length) { toast('No changes', 'warn'); return false; }
    if (Object.keys(c.file).length) {
      await applyVerified({ original: settings, changes: c.file, read: () => readDbDir(row.Directory), write: () => admin.put('/v2/database-dir', c.file, { dir: row.Directory }) }, 'Database settings saved');
    }
    if (Object.keys(c.definition).length) {
      await applyVerified({ original: definition, changes: c.definition, read: () => readDbConfig(row.Name), write: () => admin.put('/v2/database', c.definition, { name: row.Name }) }, 'Database definition saved');
    }
    resolve(true);
  } }] }));
}

function databaseDelete(row) {
  const { Name: name, Directory: dir } = row;
  const steps = [
    // The definition goes first: IRIS refuses it (409) while a namespace still uses the database.
    row.Configured && { call: { method: 'DELETE', path: pathWith('/v2/database', { name }) }, run: () => admin.del('/v2/database', { name }), read: () => readDbConfig(name) },
    row.Local && { call: { method: 'DELETE', path: pathWith('/v2/database-dir', { dir }) }, run: () => admin.del('/v2/database-dir', { dir }), read: () => readDbDir(dir) },
  ].filter(Boolean);
  return confirmAction({
    title: `Delete database ${name}`, danger: true, confirmLabel: 'Delete', confirmText: name,
    message: row.Local ? `This removes the database definition and deletes ${dir}IRIS.DAT with all data in it. It cannot be undone.` : 'This removes the database definition.',
    call: steps.map((s) => s.call), done: 'Database deleted',
    run: async () => { for (const s of steps) await s.run(); },
    // Gone only when neither the definition nor the file can be read any more.
    verify: { expect: 'gone', read: async () => {
      const left = await Promise.all(steps.map((s) => exists(s.read)));
      if (!left.some(Boolean)) throw new ApiError(`Database ${name} not found`, 404);
      return {};
    } },
  });
}

function spaceTask(row, op, reload) {
  const path = `/v2/database-dir/${op.id}`;
  const input = h('input', { type: 'number', min: 0, value: op.field === 'Size' ? Number(row.Size || 0) + 1 : 0 });
  const preview = h('div');
  const build = () => {
    const value = Number(input.value);
    if (input.value === '' || !(value >= 0)) throw new Error(`${op.fieldLabel} must be 0 or more.`);
    if (op.field === 'Size' && value <= Number(row.Size || 0)) throw new Error(`The new size must be larger than the current ${row.Size} MB.`);
    return { [op.field]: value };
  };
  modal(`${op.label} ${row.Name}`, [h('p', op.message), h('div.field', h('label', op.fieldLabel), input),
    toolbar(button('Preview API call', () => { try { clear(preview, apiCallPreview('POST', pathWith(path, { dir: row.Directory }), build())); } catch (e) { toastError(e); } }, 'small')), preview],
  { actions: [{ label: 'Cancel', onclick: () => {} }, { label: op.label, kind: 'primary', onclick: async () => {
    const body = build();
    const { result } = await applyVerified({ read: () => findInList('/v2/database-dirs', {}, 'Directory', row.Directory),
      write: () => admin.post(path, body, { dir: row.Directory }) }, `${op.label} started`);
    if (taskId(result)) watchTask(taskId(result), `${op.label}: ${row.Name}`);
    reload();
  } }] });
}

function watchTask(id, title) {
  const content = h('div', h('div.loading', 'Waiting for task…'));
  const view = modal(title, content, { wide: true });
  const poll = async () => {
    if (!view.el.isConnected) return;
    try {
      const task = await admin.get('/v2/async-result', { id });
      const { Console: consoleLines, Result: result, ...meta } = task;
      clear(content, kv(meta),
        Array.isArray(consoleLines) && consoleLines.length ? [h('h3', 'Output'), h('pre', consoleLines.join('\n'))] : null,
        result ? [h('h3', 'Result'), h('pre', JSON.stringify(result, null, 2))] : null);
      if (!taskDone(task)) setTimeout(poll, 3000);
    } catch (e) { clear(content, errorBox(e, poll)); }
  };
  poll();
}

function integrityCheck(row) {
  const body = { Databases: [{ Directory: row.Directory }] };
  return confirmAction({ title: `Check ${row.Name}`, message: 'An asynchronous integrity check will read this database and may add I/O load.',
    call: { method: 'POST', path: '/api/admin/v2/database-dir/integrity-check', body },
    run: () => admin.post('/v2/database-dir/integrity-check', body),
  }).then((result) => {
    if (!result) return;
    if (taskId(result)) watchTask(taskId(result), `Integrity check: ${row.Name}`);
    else modal(`Integrity check: ${row.Name}`, kv(result), { wide: true });
  });
}

function namespacesTab(body) {
  const reload = () => load(body, () => admin.get('/v2/namespaces'), (rows) => [toolbar(
    can('Manage') ? button([icon('plus'), 'New namespace'], () => namespaceEdit(null, reload).catch(toastError), 'primary') : null,
    button('Refresh', reload)), table([
    { key: 'Name', label: 'Namespace' }, { key: 'Globals', label: 'Globals' }, { key: 'Routines', label: 'Routines' },
    { key: 'Library', label: 'Library' }, { key: 'TempGlobals', label: 'Temporary globals' },
  ], rows || [], { empty: 'No namespaces.', onRow: (r) => namespaceDetails(r, reload) })]);
  reload();
}

// Why a namespace is locked here ('' when it is not): no edits of its default databases, no changes or deletion of
// its mappings and no deletion; only safe mappings may be added. `apps` is null when the web applications could not
// be read: then it cannot be ruled out that this portal runs there.
const LOCKED = 'only mappings can be added here, other changes could cut off this portal or IRIS itself.';
function namespaceBlock(name, apps) {
  if (CORE_NAMESPACES.has(name)) return `${name} is a system namespace: ${LOCKED}`;
  if (!apps) return `Web applications could not be read, so this portal may run in ${name}: ${LOCKED}`;
  const portal = apps.filter((a) => PORTAL_APP.test(a.Name) && String(a.Namespace).toUpperCase() === name);
  return portal.length ? `${portal.map((a) => a.Name).join(', ')} run here and this portal needs them: ${LOCKED}` : '';
}
// Fresh check right before a write: the web applications may have moved since the dialog opened.
const namespaceLock = async (name) => namespaceBlock(name, await admin.get('/v2/web-apps').catch(() => null));
// Mappings a locked namespace still accepts: none for % or AdminDeck names, and no wildcards or ranges that could cover them.
const unsafeMapping = (name) => /^(?:%|AdminDeck)|[*:]/i.test(name);

async function namespaceDetails(row, reload) {
  const content = h('div', h('div.loading', 'Loading…'));
  const m = modal(`Namespace ${row.Name}`, content, { wide: true });
  const refresh = async () => {
    try {
      // Web applications need Secure: without them the namespace stays locked, the rest still loads.
      let appsError = null;
      const [apps, ...maps] = await Promise.all([admin.get('/v2/web-apps').catch((e) => { appsError = e; return null; }), ...MAPPINGS.map((k) => admin.get(`/v2/namespace/${k.id}-mappings`, { namespace: row.Name }))]);
      const own = (apps || []).filter((a) => String(a.Namespace).toUpperCase() === row.Name);
      const blocked = namespaceBlock(row.Name, apps);
      const manage = can('Manage');
      clear(content, toolbar(
        manage && !blocked ? button('Edit', () => namespaceEdit(row, reload).then((ok) => { if (ok) m.close(); }, toastError)) : null,
        manage ? h('button.danger', { disabled: !!blocked, title: blocked || 'Delete namespace', onclick: () => namespaceDelete(row.Name, own).then((ok) => { if (ok) { m.close(); reload(); } }) }, 'Delete') : null),
      manage && blocked ? h('p.muted.small', blocked) : null,
      h('h3', 'Default databases'), kv(row, { skip: ['Name'] }),
      MAPPINGS.map((kind, i) => [h('h3', `${kind.label} mappings`),
        manage ? toolbar(button([icon('plus'), `Add ${kind.label.toLowerCase()} mapping`], () => mappingEdit(row.Name, kind, null).then((ok) => ok && refresh(), toastError), 'small')) : null,
        table([{ key: 'Name', label: kind.label }, { key: 'Database', label: 'Database' },
          ...(kind.id === 'global' ? [{ key: 'LockDatabase', label: 'Lock database' }] : kind.id === 'routine' ? [{ key: 'Type', label: 'Type' }] : [])],
        maps[i], { filter: maps[i].length > 10, empty: `No ${kind.label.toLowerCase()} mappings.`,
          actions: manage && !blocked ? (r) => [
            button('Edit', () => mappingEdit(row.Name, kind, r).then((ok) => ok && refresh(), toastError), 'small'),
            h('button.small.danger', { onclick: () => mappingDelete(row.Name, kind, r.Name).then((ok) => ok && refresh()) }, 'Delete')] : null })]),
      h('h3', 'Web applications'), !apps ? h('p.muted.small', `Web applications could not be read: ${appsError.message}`) : table([{ key: 'Name', label: 'Application' }, { key: 'Enabled', label: 'State', render: (a) => badge(a.Enabled ? 'Enabled' : 'Disabled', a.Enabled ? 'ok' : 'muted') }],
        own, { filter: false, empty: 'No web applications run in this namespace.' }));
    } catch (e) { clear(content, errorBox(e, refresh)); }
  };
  refresh();
}

async function namespaceEdit(row, reload) {
  const fresh = !row;
  const databases = (await admin.get('/v2/databases')).map((d) => d.Name);
  const initial = row ? { Globals: row.Globals, Routines: row.Routines, TempGlobals: row.TempGlobals } : { Globals: 'USER', Routines: 'USER', TempGlobals: 'IRISTEMP' };
  const nameInput = fresh ? h('input', { required: true, placeholder: 'MYAPP' }) : null;
  const form = objectForm(initial, [
    { key: 'Globals', label: 'Globals database', type: 'select', options: selectOptions(databases, initial.Globals) },
    { key: 'Routines', label: 'Routines database', type: 'select', options: selectOptions(databases, initial.Routines) },
    { key: 'TempGlobals', label: 'Temporary globals database', type: 'select', options: selectOptions(databases, initial.TempGlobals) },
  ]);
  const preview = h('div');
  const build = () => {
    const name = fresh ? nameInput.value.trim().toUpperCase() : row.Name;
    if (fresh && !NEW_NAME.test(name)) throw new Error('Name: a letter followed by letters, digits, _ or - (up to 64).');
    return { name, body: fresh ? form.value() : diff(initial, form.value()) };
  };
  return new Promise((resolve) => modal(fresh ? 'New namespace' : `Edit namespace ${row.Name}`, [
    fresh ? h('div.field', h('label', 'Name'), nameInput) : null, form.el,
    fresh ? h('p.muted.small', 'Web applications and interoperability are not set up for a new namespace; add them separately.') : null,
    toolbar(button('Preview API call', () => { try { const c = build(); clear(preview, apiCallPreview('PUT', pathWith('/v2/namespace', { name: c.name }), c.body)); } catch (e) { toastError(e); } }, 'small')), preview,
  ], { wide: true, onClose: () => resolve(false), actions: [{ label: 'Cancel', onclick: () => {} }, { label: fresh ? 'Create' : 'Save changes', kind: 'primary', onclick: async () => {
    const c = build();
    if (!Object.keys(c.body).length) { toast('No changes', 'warn'); return false; }
    // PUT creates or updates: creating must never silently reconfigure an existing namespace.
    if (fresh && await exists(() => readNamespace(c.name))) throw new Error(`Namespace ${c.name} already exists.`);
    const lock = fresh ? '' : await namespaceLock(c.name);
    if (lock) throw new Error(lock);
    await applyVerified({ ...(fresh ? {} : { original: initial }), changes: c.body, read: () => readNamespace(c.name),
      write: () => admin.put('/v2/namespace', c.body, { name: c.name }) }, fresh ? `Namespace ${c.name} created` : 'Namespace saved');
    reload();
    resolve(true);
  } }] }));
}

function namespaceDelete(name, apps) {
  return confirmAction({
    title: `Delete namespace ${name}`, danger: true, confirmLabel: 'Delete', confirmText: name,
    message: `This removes the namespace definition and its mappings; its databases and data stay.${apps.length ? ` IRIS also deletes the web applications of this namespace: ${apps.map((a) => a.Name).join(', ')}.` : ''}`,
    call: { method: 'DELETE', path: pathWith('/v2/namespace', { name }) },
    run: async () => { const lock = await namespaceLock(name); if (lock) throw new Error(lock); return admin.del('/v2/namespace', { name }); },
    done: 'Namespace deleted',
    verify: { read: () => readNamespace(name), expect: 'gone' },
  });
}

async function mappingEdit(namespace, kind, row) {
  const fresh = !row;
  const databases = (await admin.get('/v2/databases')).map((d) => d.Name);
  const nameInput = fresh ? h('input', { required: true }) : null;
  const form = objectForm({ Database: row?.Database || '' }, [{ key: 'Database', type: 'select', options: selectOptions(databases, row?.Database) }]);
  const preview = h('div');
  const build = () => {
    const name = fresh ? nameInput.value.trim().replace(/^\^/, '') : row.Name;
    if (!name) throw new Error(`${kind.label} name is required.`);
    return { name, body: fresh ? form.value() : diff({ Database: row.Database }, form.value()) };
  };
  const path = (name) => pathWith(`/v2/namespace/${kind.id}-mapping`, { namespace, name });
  return new Promise((resolve) => modal(fresh ? `New ${kind.label.toLowerCase()} mapping in ${namespace}` : `${kind.label} mapping ${row.Name}`, [
    fresh ? h('div.field', h('label', kind.label), nameInput, h('small.muted', kind.help)) : null, form.el,
    toolbar(button('Preview API call', () => { try { const c = build(); clear(preview, apiCallPreview('PUT', path(c.name), c.body)); } catch (e) { toastError(e); } }, 'small')), preview,
  ], { onClose: () => resolve(false), actions: [{ label: 'Cancel', onclick: () => {} }, { label: fresh ? 'Add mapping' : 'Save changes', kind: 'primary', onclick: async () => {
    const c = build();
    if (!Object.keys(c.body).length) { toast('No changes', 'warn'); return false; }
    if (fresh && await exists(() => readMapping(kind, namespace, c.name))) throw new Error(`${c.name} is already mapped in ${namespace}.`);
    const lock = await namespaceLock(namespace);
    if (lock && !fresh) throw new Error(lock);
    if (lock && unsafeMapping(c.name)) throw new Error(`${c.name}: ${namespace} is locked here, so % and AdminDeck names, wildcards and ranges cannot be mapped.`);
    await applyVerified({ ...(fresh ? {} : { original: { Database: row.Database } }), changes: c.body, read: () => readMapping(kind, namespace, c.name),
      write: () => admin.put(`/v2/namespace/${kind.id}-mapping`, c.body, { namespace, name: c.name }) }, `${kind.label} mapping saved`);
    resolve(true);
  } }] }));
}

function mappingDelete(namespace, kind, name) {
  return confirmAction({
    title: `Delete ${kind.label.toLowerCase()} mapping ${name}`, danger: true, confirmLabel: 'Delete',
    message: `${name} will be read from the default database of ${namespace} again. No data is deleted.`,
    call: { method: 'DELETE', path: pathWith(`/v2/namespace/${kind.id}-mapping`, { namespace, name }) },
    run: async () => { const lock = await namespaceLock(namespace); if (lock) throw new Error(lock); return admin.del(`/v2/namespace/${kind.id}-mapping`, { namespace, name }); },
    done: 'Mapping deleted',
    verify: { read: () => readMapping(kind, namespace, name), expect: 'gone' },
  });
}

function journalTab(body) {
  // Journal files and records need Operate (%Admin_Operate); Manage alone does not read them.
  if (!can('Operate')) { clear(body, h('p.muted', 'Journal files and records need the Operate privilege (%Admin_Operate).')); return; }
  const records = h('div.journal-records');
  const find = h('input', { type: 'search', placeholder: '^Global or ^Global("sub")', 'aria-label': 'Global to find',
    onkeydown: (e) => { if (e.key === 'Enter') findChanges(records, find.value); } });
  const reload = () => load(body, async () => Promise.all([admin.get('/v2/journal/settings'), admin.get('/v2/journal/files')]), ([settings, files]) => {
    journalFiles = newestFirst(files);
    return [
      toolbar(button('Refresh', reload), button('Switch journal file', () => confirmAction({
        title: 'Switch journal file', message: 'Close the current journal file and begin writing a new one.',
        call: { method: 'POST', path: '/api/admin/v2/journal/switch-file', body: {} },
        run: () => admin.post('/v2/journal/switch-file'), done: 'Journal file switched',
      }).then((ok) => ok && reload())), h('span.journal-find', find, button('Who changed it?', () => findChanges(records, find.value), 'primary'))),
      h('div.card', h('h2', 'Settings'), kv(settings)), h('h3', 'Files'),
      table([{ key: 'Name', label: 'File' }, { key: 'Size', label: 'Size', render: (r) => fmtBytes(r.Size) },
        { key: 'CreationTime', label: 'Created' }, { key: 'Reason', label: 'Reason' }], journalFiles, { empty: 'No journal files.',
        onRow: (r) => journalRecords(records, r), actions: (r) => [button('Records', () => journalRecords(records, r), 'small')] }),
      records,
    ];
  });
  reload();
}

let journalFiles = [];
const newestFirst = (files) => [...(files || [])].sort((a, b) =>
  String(b.CreationTime).localeCompare(String(a.CreationTime)) || String(b.Name).localeCompare(String(a.Name)));
const fileName = (path) => String(path || '').split(/[\\/]/).at(-1);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const FIND_FILES = 3; // "who changed" scans the newest files only: older ones can be large and slow to read
const FIND_ROWS = 50;

// POST /v2/journal/file/records queues a background task; its Result is the list of records.
async function readRecords(query) {
  let result = await admin.post('/v2/journal/file/records', {}, query);
  if (result && result.GUID && result.State === 'Queued') {
    const task = await waitAsync(result.GUID, { interval: 500, timeoutMs: 3 * 60 * 1000 });
    if (/fail|error|cancel/i.test(task.State)) throw new Error(task.FailureReason || `Task ${task.State}`);
    result = task.Result;
  }
  return Array.isArray(result) ? result : [];
}

const typeBadge = (r) => badge(r.ExtTypeName || r.TypeName || '—', /KILL/i.test(r.TypeName) ? 'warn' : '');
const RECORD_COLUMNS = [
  { key: 'TimeStamp', label: 'Time' },
  { key: 'TypeName', label: 'Type', render: typeBadge },
  { key: 'GlobalNode', label: 'Global', render: (r) => h('span.mono', r.GlobalNode || '—') },
  { key: 'DatabaseName', label: 'Database' },
  { key: 'ProcessID', label: 'PID' },
  { key: 'InTransaction', label: 'In transaction', render: (r) => r.InTransaction ? badge('Yes') : 'No' },
];
const RECORD_FILTERS = [['global', 'Global contains'], ['pid', 'Process ID'], ['database', 'Database contains'], ['type', 'Type'], ['from', 'From'], ['to', 'Until']];

// Records of one journal file, newest first, a page at a time.
function journalRecords(panel, file) {
  const inputs = {
    global: h('input', { placeholder: '^Orders', 'aria-label': 'Global contains' }),
    pid: h('input', { type: 'number', min: 1, 'aria-label': 'Process ID' }),
    database: h('input', { placeholder: '/usr/irissys/mgr/user/', 'aria-label': 'Database contains' }),
    type: h('select', { 'aria-label': 'Type' }, h('option', { value: '' }, 'Any'), RECORD_TYPES.map((t) => h('option', { value: t }, t))),
    from: h('input', { type: 'datetime-local', step: 1, 'aria-label': 'From' }),
    to: h('input', { type: 'datetime-local', step: 1, 'aria-label': 'Until' }),
  };
  const hideOwn = h('input', { type: 'checkbox', checked: true, onchange: () => readPage(true) });
  const status = h('p.muted.small.journal-status');
  const result = h('div');
  const more = h('div.toolbar');
  const state = { rows: [], read: 0, offset: null, applied: {}, hidden: 0 };
  const describe = () => {
    const [first, ...rest] = conditions(state.applied);
    return `Showing ${plural(state.rows.length, 'record')}, newest first, of the latest ${state.read} ${first ? 'matching' : 'in this file'}`
      + `${state.offset ? '; older records not loaded yet' : '; whole file read'}.`
      + (first ? ` IRIS matched ${first.label.toLowerCase()} ${first.value}` : '')
      + (rest.length ? `; ${rest.map((c) => c.label.toLowerCase()).join(', ')} narrowed each page here.` : first ? '.' : '')
      + (state.hidden ? ` ${plural(state.hidden, 'record')} of API background tasks and bare transaction markers hidden.` : '');
  };
  const show = () => {
    status.textContent = describe();
    clear(result, table(RECORD_COLUMNS, state.rows, { empty: 'No records match.', pageSize: PAGE_SIZE,
      placeholder: 'Filter loaded records…', onRow: (r) => recordDetails(file.Name, r) }));
    clear(more, state.offset ? button(`Load ${PAGE_SIZE} older`, () => readPage(false)) : null);
  };
  let generation = 0;
  const readPage = async (restart) => {
    // Only the newest search may write: an older one still in flight is dropped when it answers.
    const mine = restart ? ++generation : generation;
    if (restart) Object.assign(state, { rows: [], read: 0, hidden: 0, offset: null, applied: Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) });
    clear(more, loading('Reading journal…'));
    try {
      // A page can be all hidden bookkeeping: read on (a few pages at most) until something is left to show.
      for (let pages = 0, shown = 0; pages < 5 && !shown; pages++) {
        const rows = await readRecords(recordsQuery(file.Name, state.applied, { offset: state.offset }));
        if (mine !== generation) return;
        // initialOffset is inclusive: the record the previous page ended with comes again.
        const added = rows.filter((r) => !(state.offset && Number(r.Address) === state.offset));
        const kept = refine(added, state.applied, { hideOwn: hideOwn.checked });
        state.read += added.length;
        state.hidden += refine(added, state.applied).length - kept.length;
        state.rows.push(...kept);
        state.offset = rows.length >= PAGE_SIZE ? nextOffset(rows) : null;
        shown = kept.length || !state.offset;
      }
      show();
    } catch (e) { if (mine === generation) { clear(more); clear(result, errorBox(e, () => readPage(restart))); } }
  };
  clear(panel, h('div.card',
    h('h2', h('span', `Records in ${fileName(file.Name)}`), h('span.muted.small', `${fmtBytes(file.Size)} · created ${file.CreationTime || '—'}`)),
    h('div.form-grid', RECORD_FILTERS.map(([k, label]) => h('div.field', h('label', label), inputs[k]))),
    toolbar(button('Show records', () => readPage(true), 'primary'),
      button('Clear filters', () => { Object.values(inputs).forEach((el) => { el.value = ''; }); readPage(true); }),
      h('label.journal-hide', hideOwn, ' Hide API task bookkeeping and bare transaction markers')),
    status, result, more));
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  readPage(true);
}

// "Who changed ^X": the latest records of a global across the newest journal files.
async function findChanges(panel, value) {
  const global = globalRef(value);
  if (!global) { toast('Enter a global name, e.g. ^Orders', 'warn'); return; }
  const files = journalFiles.slice(0, FIND_FILES);
  const content = h('div', loading(`Searching ${plural(files.length, 'journal file')}…`));
  clear(panel, h('div.card', h('h2', h('span', `Changes to ${global}`), h('span.muted.small', `newest ${files.length} of ${journalFiles.length} files`)), content));
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const found = await Promise.all(files.map(async (f) =>
      (await readRecords(recordsQuery(f.Name, { global }, { pageSize: FIND_ROWS }))).map((r) => ({ ...r, File: f.Name }))));
    // Timestamps have one-second resolution: within a file the address gives the order.
    const rows = found.flat().sort((a, b) => String(b.TimeStamp).localeCompare(String(a.TimeStamp)) || Number(b.Address) - Number(a.Address));
    const capped = found.some((list) => list.length >= FIND_ROWS);
    clear(content, h('p.muted.small.journal-status', `${plural(rows.length, 'change')} found, newest first`
      + `${capped ? ` (at most ${FIND_ROWS} per file: open a file for older ones)` : ''}. Old values are journaled only inside transactions.`),
    table([...RECORD_COLUMNS, { key: 'File', label: 'File', render: (r) => fileName(r.File) }], rows, {
      empty: `No changes to ${global} in the newest journal files.`, onRow: (r) => recordDetails(r.File, r) }));
  } catch (e) { clear(content, errorBox(e, () => findChanges(panel, value))); }
}

async function recordDetails(file, row) {
  const content = h('div', loading());
  modal(`Journal record ${row.Address}`, content, { wide: true });
  try {
    const rec = await admin.get('/v2/journal/file/record', { file, address: row.Address });
    const sk = rec.SetKill || {};
    const v = recordValues(rec);
    const shown = (has, value, missing) => has ? h('pre', String(value)) : h('span.muted', missing);
    clear(content, h('dl.kv.journal-record',
      h('dt', 'Global'), h('dd', h('span.mono', sk.GlobalReference || sk.GlobalNode || row.GlobalNode || '—')),
      h('dt', 'Operation'), h('dd', typeBadge(rec)),
      h('dt', 'Old value'), h('dd', shown(v.hasOld, v.oldValue, rec.InTransaction ? '— (node had no value)' : '— (not journaled outside a transaction)')),
      h('dt', 'New value'), h('dd', shown(v.hasNew, v.newValue, /KILL/i.test(rec.TypeName) ? '— (killed)' : '—')),
      h('dt', 'Time'), h('dd', rec.TimeStamp || '—'),
      h('dt', 'Process'), h('dd', String(rec.ProcessID ?? '—'), rec.JobID !== undefined ? h('span.muted', ` (job ${rec.JobID})`) : null),
      h('dt', 'Transaction'), h('dd', rec.InTransaction ? 'Inside a transaction' : 'Not in a transaction'),
      h('dt', 'Database'), h('dd', sk.DatabaseName || row.DatabaseName || '—'),
      h('dt', 'File'), h('dd', `${file} @ ${row.Address}`)),
    h('p.muted.small', 'IRIS keeps the old value only for changes made inside a transaction (it is needed for rollback).'),
    h('details', h('summary', 'Raw record'), kv(rec)));
  } catch (e) { clear(content, errorBox(e)); }
}

const DEVICE_TYPES = [['TRM', 'Terminal'], ['SPL', 'Spooling device'], ['MT', 'Magnetic tape drive'], ['BT', 'Cartridge tape drive'], ['IPC', 'Interprocess communication'], ['OTH', 'Other (incl. printers, sequential files)']];
const DEVICE_FIELDS = [
  { key: 'PhysicalDevice', label: 'Physical device' },
  { key: 'Description', type: 'textarea' },
  { key: 'Type', type: 'select', options: DEVICE_TYPES },
  { key: 'SubType', label: 'Subtype', help: 'e.g. M/UX' },
  { key: 'Alias', type: 'number' },
  { key: 'AlternateDevice', label: 'Alternate device' },
  { key: 'OpenParameters', label: 'Open parameters', help: 'e.g. ("auv":0:2048)' },
  { key: 'Prompt', type: 'number', help: 'Blank = prompt user, 1 = auto-use, 2 = auto-use with defaults' },
];

function devicesTab(body) {
  const reload = () => load(body, () => admin.get('/v2/devices'), (rows) => [
    toolbar(button('Device settings', deviceSettings), button('Refresh', reload)),
    table([
      { key: 'Name', label: 'Device' }, { key: 'PhysicalDevice', label: 'Physical device' },
      { key: 'Type', label: 'Type' }, { key: 'Description', label: 'Description' },
    ], rows || [], { empty: 'No devices.', onRow: (r) => deviceDetails(r.Name, reload) }),
  ]);
  reload();
}

async function deviceDetails(name, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(`Device ${name}`, body, { wide: true });
  try {
    const device = await readDevice(name);
    clear(body, toolbar(can('Manage') ? button('Edit', () => { m.close(); deviceEdit(name, device, reload); }) : null), kv({ Name: name, ...device }));
  } catch (e) { clear(body, errorBox(e)); }
}

function deviceEdit(name, current, reload) {
  const form = objectForm(current, DEVICE_FIELDS);
  const preview = h('div');
  const build = () => diff(current, form.value());
  modal(`Edit device ${name}`, [form.el,
    toolbar(button('Preview API call', () => { try { clear(preview, apiCallPreview('PUT', `/api/admin/v2/device?name=${encodeURIComponent(name)}`, build())); } catch (e) { toastError(e); } }, 'small')), preview],
  { wide: true, actions: [{ label: 'Cancel', onclick: () => {} }, { label: 'Save changes', kind: 'primary', onclick: async () => {
    const payload = build();
    if (!Object.keys(payload).length) { toast('No changes', 'warn'); return false; }
    await applyVerified({ original: current, changes: payload, read: () => readDevice(name),
      write: () => admin.put('/v2/device', payload, { name }) }, 'Device saved');
    reload();
  } }] });
}

// Read + edit for telnet / device-I/O settings, which apply instance-wide (no per-device delete is offered:
// devices here are system-defined mnemonics, not something this deck should let you remove).
function deviceSettings() {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal('Device settings', body, { wide: true });
  const refresh = () => loadDeviceSettings(body, m);
  refresh();
}

async function loadDeviceSettings(body, m) {
  try {
    const settings = await readDeviceSettings();
    clear(body, toolbar(can('Manage') ? button('Edit', () => { m.close(); deviceSettingsEdit(settings); }) : null), kv(settings));
  } catch (e) { clear(body, errorBox(e, () => loadDeviceSettings(body, m))); }
}

function deviceSettingsEdit(current) {
  const telnet = objectForm(current.TelnetSettings || {}, [
    { key: 'DNSLookup', label: 'DNS lookup', type: 'select', options: ['ON', 'OFF'] },
    { key: 'Port', type: 'number' },
  ]);
  const io = objectForm(current.IOSettings || {}, [
    { key: 'Terminal', help: 'Routine for WRITE to terminals, e.g. ^%X364' },
    { key: 'File', help: 'Routine for WRITE to sequential files' },
    { key: 'MagTape', label: 'Magnetic tape', help: 'Routine for WRITE to magnetic tapes' },
    { key: 'Other', help: 'Routine for WRITE to other devices' },
  ]);
  const preview = h('div');
  const build = () => {
    const body = {};
    const t = diff(current.TelnetSettings || {}, telnet.value());
    const i = diff(current.IOSettings || {}, io.value());
    if (Object.keys(t).length) body.TelnetSettings = t;
    if (Object.keys(i).length) body.IOSettings = i;
    return body;
  };
  modal('Edit device settings', [h('h3', 'Telnet'), telnet.el, h('h3', 'Device I/O'), io.el,
    toolbar(button('Preview API call', () => { try { clear(preview, apiCallPreview('PUT', '/api/admin/v2/device/settings', build())); } catch (e) { toastError(e); } }, 'small')), preview],
  { wide: true, actions: [{ label: 'Cancel', onclick: () => {} }, { label: 'Save changes', kind: 'primary', onclick: async () => {
    const payload = build();
    if (!Object.keys(payload).length) { toast('No changes', 'warn'); return false; }
    await applyVerified({
      original: settingsFields(current, payload), changes: payload,
      read: async () => settingsFields(await readDeviceSettings(), payload),
      write: () => admin.put('/v2/device/settings', payload),
    }, 'Device settings saved');
    deviceSettings();
  } }] });
}

// Backups (read-only): the history IRIS records for backup runs, the Task Manager tasks that run backups and the
// backup definitions they use. The SysAdmin API reports only "last backup", so this comes from the extension.
const BACKUP_TYPES = ['Full', 'Incremental', 'Cumulative'];
const shortClass = (c) => String(c || '').replace(/^%SYS\.Task\./, '');
function backupsTab(body) {
  const reload = () => load(body, () => ext.get('/backups'), (b) => {
    const last = b.lastSuccessful || {};
    const types = [...BACKUP_TYPES, ...(last.External ? ['External'] : [])];
    const tasksLink = can('Operate', 'Task') ? h('a', { href: '#/tasks' }, 'Tasks') : 'Tasks';
    return [
      toolbar(button('Refresh', reload)),
      h('div.grid.stats', types.map((t) => {
        const r = last[t];
        return h('div.card', h('div.stat-label', `Last ${t.toLowerCase()} backup`),
          h('div.stat-value', r ? r.time : 'Never'),
          h('div.stat-sub', r ? `${typeof r.ageDays === 'number' ? (r.ageDays === 0 ? 'today' : `${r.ageDays} d ago`) : ''} ${r.status ? `· ${r.status}` : ''}` : 'no successful run recorded'));
      })),
      b.history.length ? null : h('div.card', { style: { marginTop: '16px' } },
        h('h2', 'No backup has run on this instance'),
        h('p', 'IRIS records every run of its backup tasks here (and external backups registered with ',
          h('code', 'Backup.General.ExternalSetHistory()'), '). Nothing is recorded yet.'),
        h('p', 'To schedule one: open ', tasksLink, ', create a task with task class ', h('code', '%SYS.Task.BackupAllDatabases'),
          ' (or ', h('code', 'BackupFullDatabaseList'), ' / ', h('code', 'BackupIncrementDatabaseList'), ' / ', h('code', 'BackupCumulativeDatabaseList'),
          ' for the databases in the backup list) in namespace %SYS, choose a schedule and run it once. The backup files go to the device of the matching definition below.'),
        h('p.muted.small', 'In a container, write backups to a mounted volume: a backup that stays inside the container is lost with it.')),
      h('h3', 'Backup tasks in the Task Manager'),
      table([
        { key: 'name', label: 'Task' },
        { key: 'taskClass', label: 'Type', render: (r) => shortClass(r.taskClass) },
        { key: 'suspended', label: 'State', render: (r) => (r.suspended ? badge('Suspended', 'warn') : badge('Scheduled', 'ok')) },
        { key: 'lastFinished', label: 'Last finished', render: (r) => r.lastFinished || '—' },
        // Status is the %OnTask result (1 = success, negative = job error); Error may also hold scheduling notes.
        { key: 'status', label: 'Last result', render: (r) => (!r.lastFinished ? '—' : String(r.status) === '1' ? badge('OK', 'ok')
          : h('span', { title: r.error || '' }, badge('Error', 'err'))) },
        { key: 'nextRun', label: 'Next run' },
      ], b.scheduled, { filter: false, empty: 'No Task Manager task runs a backup.',
        onRow: can('Operate', 'Task') ? (r) => { location.hash = `#/tasks/${r.id}`; } : null }),
      h('h3', 'Backup history'),
      table([
        { key: 'time', label: 'Time' },
        { key: 'type', label: 'Type' },
        { key: 'status', label: 'Status', render: (r) => badge(r.status || '—', r.ok ? 'ok' : 'err') },
        { key: 'databases', label: 'Databases', render: (r) => h('span.small', r.databases || '') },
        { key: 'logFile', label: 'Log file', render: (r) => h('code.small', r.logFile || '') },
      ], b.history, { empty: 'No backup recorded.', pageSize: 50 }),
      h('h3', 'Backup definitions'),
      table([
        { key: 'name', label: 'Definition' }, { key: 'type', label: 'Type' }, { key: 'device', label: 'Device' },
        { key: 'lastRun', label: 'Last run', render: (r) => r.lastRun || 'never' },
        { key: 'statusText', label: 'Last status', render: (r) => r.statusText || r.status || '—' },
        { key: 'description', label: 'Description', render: (r) => h('span.small', r.description || '') },
      ], b.definitions, { filter: false, empty: 'No backup definitions.' }),
      h('p.muted.small', b.lastFull.recorded ? `Last full backup recorded by IRIS: ${b.lastFull.time} · ${b.lastFull.description} · ${b.lastFull.device}`
        : `Last full backup recorded by IRIS: none (${b.lastFull.description}).`),
    ];
  });
  reload();
}

function licenseTab(body) {
  const reload = () => load(body, async () => Promise.all([admin.get('/v2/license/key'), admin.get('/v2/monitor/license-usage')]), ([key, usage]) =>
    [toolbar(button('Refresh', reload)), h('div.grid.wide', h('div.card', h('h2', 'License key'), kv(key)),
      h('div.card', h('h2', 'Current usage'),
        table([{ key: 'LicenseUnitUse', label: 'License units' }, { key: 'Local', label: 'Local' }, { key: 'Distributed', label: 'Distributed' }], usage.Summary || [], { filter: false }),
        h('h3', 'By user'),
        table([{ key: 'UserId', label: 'User' }, { key: 'Type', label: 'Type' }, { key: 'LU', label: 'Units' }, { key: 'Connects', label: 'Connections' },
          { key: 'MaxCon', label: 'Max' }, { key: 'CSPCon', label: 'Web' }], usage.UsageByUser || [], { empty: 'No license users.', filter: false }),
        // Most processes (system daemons) hold no license unit: only the ones that do are listed.
        h('h3', 'Processes holding units'),
        table([{ key: 'PID', label: 'PID' }, { key: 'Process', label: 'Process' }, { key: 'Type', label: 'Type' }, { key: 'LU', label: 'Units' }, { key: 'Con', label: 'Connections' }],
          (usage.UsageByProcess || []).filter((p) => Number(p.LU) > 0 || Number(p.Con) > 0), { empty: 'No process holds a license unit.', filter: false })))]);
  reload();
}

function jobsTab(body) {
  const reload = () => load(body, () => admin.get('/v2/async-results'), (rows) => [toolbar(button('Refresh', reload)), table([
    { key: 'TaskName', label: 'Task' }, { key: 'GUID', label: 'ID' },
    { key: 'State', label: 'State', render: (r) => badge(r.State || '—') },
    { key: 'TimeQueued', label: 'Queued' }, { key: 'TimeFinished', label: 'Finished' },
  ], rows || [], { empty: 'No background jobs for this user.', onRow: (r) => watchTask(r.GUID, r.TaskName || 'Background job'),
    actions: can('Operate') ? (r) => !taskDone(r) ? [button('Cancel', () => confirmAction({
      title: 'Cancel background job', message: `Cancel ${r.TaskName || r.GUID}? Work in progress may stop before completion.`,
      call: { method: 'POST', path: pathWith('/v2/async-result/cancel', { id: r.GUID }), body: {} }, danger: true,
      run: () => admin.post('/v2/async-result/cancel', {}, { id: r.GUID }), done: 'Cancellation requested',
    }).then((ok) => ok && reload()), 'small')] : [] : null,
  })]);
  reload();
}
