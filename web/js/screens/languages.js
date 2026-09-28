// External language servers (Java, .NET, Python, … gateways): state, start/stop, settings, create/delete.
// Every call needs %Admin_ExternalLanguageServerEdit:U, so the whole screen is gated by that privilege.
import { admin } from '../api.js';
import { h, page, table, load, modal, confirmAction, applyVerified, objectForm, kv, badge, toast, toastError, apiCallPreview, button, toolbar, clear, icon } from '../ui.js';
import { TYPES, LABELS, customKeys, builtIn, flatten, serverBody } from '../extlang.js';

const path = (name, action = '') => `/api/admin/v2/ext-lang-server${action}?name=${encodeURIComponent(name)}`;
const readServer = (name) => admin.get('/v2/ext-lang-server', { name });
const readActivity = (name, maxRows) => admin.get('/v2/ext-lang-server/activity', { name, maxRows });
const readState = async (name) => ({ Running: !!(await readActivity(name, 1)).CurrentlyRunning });
const stateBadge = (running) => (running === undefined ? badge('Unknown', 'muted') : badge(running ? 'Running' : 'Stopped', running ? 'ok' : 'muted'));
const COMMON = [
  { key: 'Port', type: 'number', required: true }, { key: 'BindToIPAddress', label: 'Bind to IP address' },
  { key: 'Resource', help: 'Empty = anyone may use this server' },
  { key: 'ConnectionTimeout', label: 'Connection timeout (s)', type: 'number' },
  { key: 'InitializationTimeout', label: 'Initialization timeout (s)', type: 'number' },
  { key: 'UseSharedMemory', label: 'Use shared memory', type: 'bool' }, { key: 'LogFile', label: 'Log file' },
  { key: 'SSLConfigurationServer', label: 'Server TLS configuration' }, { key: 'SSLConfigurationClient', label: 'Client TLS configuration' },
  { key: 'VerifySSLHostName', label: 'Verify TLS host name', type: 'bool' },
];
const fields = (type) => [...COMMON, ...customKeys(type).map((key) => ({ key, label: LABELS[key], type: key === 'Exec32' ? 'bool' : 'text' }))];

export default async function render(el, params) {
  const body = h('div');
  el.append(page('Language servers', 'External language servers (gateways) for Python, Java, .NET and more.', body));
  const reload = () => load(body, async () => {
    const rows = await admin.get('/v2/ext-lang-servers');
    // The list has no state: one activity read per server (a failure only leaves that state unknown).
    return Promise.all((rows || []).map((r) => readState(r.Name).then((s) => ({ ...r, ...s }), () => r)));
  }, (rows) => [
    toolbar(button([icon('plus'), 'New server'], () => edit(null, reload), 'primary'), button('Refresh', reload)),
    table([
      { key: 'Name', label: 'Server' }, { key: 'Type', label: 'Type', render: (r) => badge(r.Type || '—') },
      { key: 'Port', label: 'Port' }, { key: 'Running', label: 'State', render: (r) => stateBadge(r.Running) },
    ], rows, { sortKey: 'Name', onRow: (r) => details(r.Name, reload), empty: 'No external language servers.',
      actions: (r) => [startStop(r.Name, r.Running, reload)] }),
  ]);
  await reload();
  if (params?.[0]) details(params[0], reload);
}

function startStop(name, running, after) {
  if (running === undefined) return null;
  const action = running ? 'stop' : 'start';
  return button(running ? 'Stop' : 'Start', () => confirmAction({
    title: `${running ? 'Stop' : 'Start'} ${name}`, danger: running, confirmLabel: running ? 'Stop' : 'Start',
    message: running ? 'Open connections to this server are closed; code that uses it fails until it is started again.'
      : 'The server process is started on the IRIS host (this can take several seconds).',
    call: { method: 'POST', path: path(name, `/${action}`), body: {} },
    run: () => admin.post(`/v2/ext-lang-server/${action}`, {}, { name }),
    verify: { read: () => readState(name), changes: { Running: !running } }, done: running ? 'Server stopped' : 'Server started',
  }).then((ok) => ok && after()), 'small');
}

async function details(name, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(name, body, { wide: true });
  const done = () => { m.close(); reload(); };
  try {
    const [server, activity] = await Promise.all([readServer(name), readActivity(name, 20)]);
    const running = !!activity.CurrentlyRunning;
    clear(body, h('p', 'State: ', stateBadge(running)), toolbar(
      startStop(name, running, done),
      button('Edit', () => { m.close(); edit({ ...server, Name: name }, reload); }),
      h('button.danger', { disabled: builtIn(name), title: builtIn(name) ? 'Built-in servers cannot be deleted' : 'Delete server', onclick: () => confirmAction({
        title: `Delete ${name}`, danger: true, confirmLabel: 'Delete', confirmText: name,
        message: `This permanently removes the server definition.${running ? ' It is running: stop it first so no process is left behind.' : ''}`,
        call: { method: 'DELETE', path: path(name) }, run: () => admin.del('/v2/ext-lang-server', { name }),
        verify: { read: () => readServer(name), expect: 'gone' }, done: 'Server deleted',
      }).then((ok) => ok && done()) }, 'Delete')),
    h('h3', 'Settings'), kv(flatten(server)),
    h('h3', 'Recent activity'), table([
      { key: 'DateTime', label: 'Time' }, { key: 'RecordType', label: 'Type', render: (r) => badge(r.RecordType, /error/i.test(r.RecordType) ? 'err' : /warn/i.test(r.RecordType) ? 'warn' : '') },
      { key: 'Job', label: 'Job' }, { key: 'Text', label: 'Message' },
    ], activity.Activity || [], { empty: 'No activity recorded.', pageSize: 20 }));
  } catch (e) { clear(body, h('div.error-box', e.message)); }
}

function edit(server, reload) {
  const fresh = !server;
  const nameInput = fresh ? h('input', { required: true, placeholder: 'My Python Server' }) : null;
  const typeSelect = fresh ? h('select', TYPES.map((t) => h('option', { value: t }, t))) : null;
  const formBox = h('div', { style: { marginTop: '12px' } });
  const preview = h('div');
  let form;
  const drawForm = () => {
    const type = fresh ? typeSelect.value : server.Type;
    form = objectForm(fresh ? { Port: '', BindToIPAddress: '127.0.0.1', Resource: '%Gateway_Object', ConnectionTimeout: 5, InitializationTimeout: 5 } : flatten(server), fields(type));
    clear(formBox, form.el);
  };
  if (fresh) typeSelect.addEventListener('change', drawForm);
  drawForm();
  const build = () => {
    const name = fresh ? nameInput.value.trim() : server.Name;
    if (!name) throw new Error('Name is required.');
    const values = form.value();
    if (fresh) values.Type = typeSelect.value;
    return { name, body: serverBody(values, fresh ? null : server) };
  };
  modal(fresh ? 'New language server' : `Edit ${server.Name}`, [
    fresh ? h('div.form-grid', h('div.field', h('label', 'Name'), nameInput), h('div.field', h('label', 'Type'), typeSelect)) : h('p', 'Type: ', badge(server.Type)),
    formBox,
    toolbar(button('Preview API call', () => { try { const c = build(); clear(preview, apiCallPreview('PUT', path(c.name), c.body)); } catch (e) { toastError(e); } }, 'small')), preview,
  ], { wide: true, actions: [{ label: 'Cancel', onclick: () => {} }, { label: fresh ? 'Create' : 'Save changes', kind: 'primary', onclick: async () => {
    const c = build();
    if (!Object.keys(c.body).length) { toast('No changes', 'warn'); return false; }
    // PUT creates or updates: creating must never silently reconfigure an existing server.
    if (fresh && await readServer(c.name).then(() => true, (e) => { if (e.status === 404) return false; throw e; })) {
      throw new Error(`${c.name} already exists. Open it from the list to change it.`);
    }
    await applyVerified({
      ...(fresh ? { expect: 'exists' } : { original: server, changes: c.body }),
      read: () => readServer(c.name), write: () => admin.put('/v2/ext-lang-server', c.body, { name: c.name }),
    }, fresh ? 'Server created' : 'Server saved');
    reload();
  } }] });
}
