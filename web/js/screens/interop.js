// Interoperability: the production of every namespace with Interoperability enabled — state, items with errors,
// queues, recent errors — and start / stop / update / recover. The SysAdmin API has no production endpoints, so this
// screen uses the extension (/admindeck/api/interop), which checks %Ens_ProductionRun on the server for every action.
// Every action reads the production state back (verified change); stopping requires typing the production name.
// Stop, update and recover name the production the user saw: the server refuses them (409) when another
// production runs by then, so a dialog opened for A can never act on B.
import { admin, ext, waitAsync } from '../api.js';
import { StaleError } from '../verify.js';
import { can } from '../app.js';
import { h, page, table, load, confirmAction, badge, button, toolbar, kv } from '../ui.js';

const STATE_KIND = { Running: 'ok', Stopped: 'muted', Suspended: 'warn', Troubled: 'err', NetworkStopped: 'warn', Unknown: 'warn' };
// Never offered for enabling Interoperability.
const SYSTEM_NAMESPACES = new Set(['%SYS', '%ALL']);
const enc = encodeURIComponent;
const stateBadge = (state) => badge(state || 'Unknown', STATE_KIND[state] || 'warn');
const actionPath = (ns, action) => `/admindeck/api/interop/${enc(ns)}/${action}`;

/** What a verified change compares: the production state as the server reports it now. */
async function readState(ns) {
  const s = await ext.get(`/interop/${enc(ns)}`);
  return { state: s.state, production: s.production, needsUpdate: s.needsUpdate, troubled: s.state === 'Troubled' };
}

export default async function render(el, params) {
  const body = h('div');
  el.append(page('Interoperability', null, body));
  if (params[0]) namespaceView(body, params[0]); else overview(body);
}

// ---------- all namespaces ----------
function overview(body) {
  const reload = () => load(body, () => ext.get('/interop'), ({ namespaces, canRun }) => {
    const enabled = namespaces.filter((n) => n.enabled);
    const others = namespaces.filter((n) => !n.enabled && !SYSTEM_NAMESPACES.has(n.namespace));
    return [
      toolbar(button('Refresh', reload)),
      enabled.length ? h('div.grid.wide', enabled.map((n) => namespaceCard(n, canRun, reload)))
        : h('div.card', h('h2', 'No namespace has Interoperability enabled'),
          h('p', 'Productions (business services, processes and operations) run only in namespaces with Interoperability enabled. ',
            'Enabling it maps the Interoperability classes and globals into the namespace; it is done once per namespace.'),
          others.length ? null : h('p.muted', 'Create an application namespace first (Databases & system → Namespaces); %SYS cannot run productions.')),
      others.length ? [h('h3', enabled.length ? 'Namespaces without Interoperability' : 'Enable it in a namespace'),
        table([
          { key: 'namespace', label: 'Namespace' },
          { key: 'enabled', label: 'Interoperability', render: () => badge('Not enabled', 'muted') },
        ], others, { filter: false, actions: can('Manage') ? (n) => [button('Enable Interoperability', () => enableInterop(n.namespace, reload), 'small')] : null })] : null,
      !can('Manage') && others.length ? h('p.muted.small', 'Enabling Interoperability needs %Admin_Manage.') : null,
    ];
  });
  reload();
}

function namespaceCard(n, canRun, reload) {
  const open = () => { location.hash = `#/interop/${enc(n.namespace)}`; };
  if (n.error) return h('div.card', h('h2', n.namespace, badge('Unreadable', 'err')), h('p.muted', n.error));
  return h('div.card',
    h('h2', h('span', n.namespace), n.production || startCandidate(n) ? stateBadge(n.state) : badge('No production', 'muted')),
    h('dl.kv',
      h('dt', 'Production'), h('dd', productionLabel(n)),
      h('dt', 'Errors, last hour'), h('dd', n.errorsLastHour ? badge(String(n.errorsLastHour), 'err') : '0'),
      n.needsUpdate ? [h('dt', 'Configuration'), h('dd', badge('Changes not applied', 'warn'), ' ', h('span.small.muted', n.updateReason || ''))] : null),
    h('div', { style: { marginTop: '12px' } }, toolbar(button('Open', open, 'small'), canRun ? productionActions(n.namespace, n, reload) : null)));
}

const productionLabel = (s) => s.production || (startCandidate(s) ? `${startCandidate(s)} (not running)` : 'No production in this namespace');

// ---------- one namespace ----------
function namespaceView(body, ns) {
  const reload = () => load(body, () => ext.get(`/interop/${enc(ns)}`), (s) => [
    toolbar(h('a', { href: '#/interop' }, '← All namespaces'), button('Refresh', reload),
      s.canRun ? productionActions(ns, s, reload) : h('span.muted.small', 'Starting and stopping needs %Ens_ProductionRun.')),
    h('div.card',
      h('h2', h('span', `${ns} · ${productionLabel(s)}`), stateBadge(s.state)),
      kv({ Namespace: ns, Production: productionLabel(s), State: s.state, 'Errors in the last hour': s.errorsLastHour,
        'Changes not applied': s.needsUpdate ? `yes: ${s.updateReason || 'the configuration changed since the production started'}` : 'no' })),
    s.canRun && s.productions.length > 1 && s.state !== 'Running' ? [h('h3', 'Productions in this namespace'),
      table([{ key: 'name', label: 'Production' }], s.productions.map((name) => ({ name })), {
        filter: false, actions: (r) => [startButton(ns, r.name, s, reload)] })] : null,
    h('h3', 'Items'),
    table([
      { key: 'name', label: 'Item' },
      { key: 'className', label: 'Class', render: (r) => h('span.small', r.className) },
      { key: 'enabled', label: 'Enabled', render: (r) => (r.enabled ? 'Yes' : badge('No', 'muted')) },
      { key: 'status', label: 'Status', render: (r) => badge(r.status || '—', /^ok$/i.test(r.status) ? 'ok' : /error/i.test(r.status) ? 'err' : 'muted') },
      { key: 'queue', label: 'Queue', sort: (r) => r.queue, render: (r) => (r.queue ? badge(String(r.queue), 'warn') : '0') },
      { key: 'count', label: 'Messages', sort: (r) => r.count },
      { key: 'errorsLastHour', label: 'Errors (1 h)', sort: (r) => r.errorsLastHour, render: (r) => (r.errorsLastHour ? badge(String(r.errorsLastHour), 'err') : '0') },
      { key: 'lastActivity', label: 'Last activity' },
    ], s.items, { empty: s.production ? 'The production has no items.' : 'No production has run in this namespace.', sortKey: 'errorsLastHour' }),
    h('h3', 'Queues'),
    table([{ key: 'name', label: 'Queue' }, { key: 'count', label: 'Messages waiting', sort: (r) => r.count }], s.queues,
      { filter: false, empty: 'No queues.' }),
    h('h3', 'Recent errors (Event Log)'),
    table([
      { key: 'time', label: 'Time (UTC)' }, { key: 'item', label: 'Item' },
      { key: 'text', label: 'Error', render: (r) => h('span.small', r.text) },
    ], s.recentErrors, { empty: 'No errors in the Event Log.' }),
  ]);
  reload();
}

// ---------- actions (all verified by reading the state back) ----------
const startCandidate = (s) => s.production || s.lastProduction || (s.productions || [])[0] || '';

function productionActions(ns, s, reload) {
  const running = s.state === 'Running';
  const candidate = startCandidate(s);
  return [
    !running && s.state !== 'Troubled' && candidate ? startButton(ns, candidate, s, reload) : null,
    running && s.needsUpdate ? button('Apply changes', () => act(ns, 'update', s, reload, {
      title: `Apply configuration changes to ${s.production}`,
      message: 'Items whose settings changed are restarted with the new configuration; the rest keep running.',
      confirmLabel: 'Update', changes: { needsUpdate: false }, done: 'Production updated',
    }), 'small') : null,
    // Ens.Director.RecoverProduction only cleans up; it does not start anything. Once the troubled
    // state is cleared the production is stopped and Start is offered on its own.
    s.state === 'Troubled' ? button('Recover', () => act(ns, 'recover', s, reload, {
      title: `Recover ${s.production || 'the production'} in ${ns}`,
      message: 'Cleans up after a production that did not shut down properly (its jobs and runtime state), so it can be started again. It does not start the production: use Start afterwards.',
      confirmLabel: 'Clean up', changes: { troubled: false }, done: 'Troubled state cleared',
    }), 'small') : null,
    running || s.state === 'Suspended' ? button('Stop', () => act(ns, 'stop', s, reload, {
      title: `Stop ${s.production} in ${ns}`, danger: true, confirmText: s.production,
      message: 'All business services, processes and operations of this production stop (10 s timeout, no forced shutdown). Messages stay in their queues.',
      confirmLabel: 'Stop production', changes: { state: 'Stopped' }, done: 'Production stopped',
    }), 'small.danger') : null,
  ];
}

function startButton(ns, production, s, reload) {
  return button(`Start ${production}`, () => act(ns, 'start', s, reload, {
    title: `Start ${production} in ${ns}`, production,
    message: 'Starts the production with its current configuration: enabled items begin to receive and send messages.',
    confirmLabel: 'Start', changes: { state: 'Running', production }, done: 'Production started',
  }), 'small.primary');
}

function act(ns, action, s, reload, { title, message, confirmLabel, changes, done, danger = false, confirmText, production }) {
  // Start names the production to start; stop / update / recover name the one the user is looking at.
  const body = { production: production || s.production };
  return confirmAction({
    title, message, confirmLabel, danger, confirmText, done,
    call: { method: 'POST', path: actionPath(ns, action), body },
    run: async () => {
      // Same state is not enough: the production must still be the one shown (the server checks again).
      if (action !== 'start') {
        const now = await readState(ns);
        if (now.production !== s.production) throw new StaleError([`production (now ${now.production || 'none'})`], now);
      }
      return ext.post(`/interop/${enc(ns)}/${action}`, body);
    },
    // Refused when someone else changed the state since this page read it.
    verify: { read: () => readState(ns), original: { state: s.state, troubled: s.state === 'Troubled' }, changes },
  }).then((ok) => ok && reload());
}

function enableInterop(ns, reload) {
  return confirmAction({
    title: `Enable Interoperability in ${ns}`,
    message: 'IRIS adds the Interoperability mappings and web application to this namespace so productions can run there. This portal cannot switch it off again.',
    call: { method: 'POST', path: `/api/admin/v2/namespace/enable-interop?${new URLSearchParams({ name: ns })}`, body: {} },
    confirmLabel: 'Enable',
    run: async () => {
      const r = await admin.post('/v2/namespace/enable-interop', {}, { name: ns });
      if (r && r.GUID && r.State === 'Queued') {
        const task = await waitAsync(r.GUID);
        if (/fail|error|cancel/i.test(task.State)) throw new Error(task.FailureReason || `Task ${task.State}`);
        return task;
      }
      return r;
    },
    verify: {
      read: async () => ({ enabled: !!((await ext.get('/interop')).namespaces.find((n) => n.namespace === ns) || {}).enabled }),
      changes: { enabled: true },
    },
    done: `Interoperability enabled in ${ns}`,
  }).then((ok) => ok && reload());
}
