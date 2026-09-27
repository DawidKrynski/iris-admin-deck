import { admin, findInList } from '../api.js';
import { can } from '../app.js';
import { h, page, table, tabs, load, modal, confirmAction, kv, badge, toastError, button, toolbar, clear, errorBox } from '../ui.js';

const queryPath = (path, query) => `/api/admin${path}?${new URLSearchParams(query)}`;
const readProcess = (pid) => admin.get('/v2/process', { id: pid });
const safeProcess = (r) => {
  if (!r.Username) return 'System process: no user name.';
  if (r.CanBeTerminated === false) return 'IRIS marks this process as non-terminable.';
  if (/CSP|Web Gateway/i.test(String(r.EXEName || r.ClientExecutableName || ''))) return 'Web process: the current management request may be using it.';
  return '';
};

export default async function render(el, params) {
  el.append(page('Processes & locks', 'Inspect active work, locks and web sessions before intervening.',
    tabs([
      { id: 'processes', label: 'Processes', render: processesTab },
      { id: 'locks', label: 'Locks', render: locksTab },
      { id: 'sessions', label: 'Web sessions', render: sessionsTab },
    ], params[0])));
}

function processesTab(body) {
  const box = h('div');
  const filter = h('input', { type: 'search', placeholder: 'Server filter', 'aria-label': 'Server process filter' });
  const auto = h('input', { type: 'checkbox', checked: false, 'aria-label': 'Auto-refresh every 5 seconds' });
  let busy = false;
  const reload = async (quiet = false) => {
    if (busy || (quiet && !box.isConnected)) return;
    busy = true;
    try {
      const rows = await admin.get('/v2/processes', { filter: filter.value });
      clear(box, table([
        { key: 'Pid', label: 'PID' }, { key: 'Username', label: 'User' }, { key: 'Nspace', label: 'Namespace' },
        { key: 'Routine', label: 'Routine' }, { key: 'State', label: 'State', render: (r) => badge(r.State || '—') },
        { key: 'CPUTime', label: 'CPU' }, { key: 'Globals', label: 'Global refs' },
        { key: 'ClientName', label: 'Client' },
      ], rows || [], {
        sortKey: 'Pid', empty: 'No matching processes.', onRow: (r) => processDetails(r, reload),
        actions: can('Operate') ? (r) => {
          const reason = safeProcess(r);
          return [button('Details', () => processDetails(r, reload), 'small'),
            /SUSP/i.test(String(r.State || ''))
              ? button('Resume', () => processAction(r, 'resume', reload), 'small')
              : h('button.small', { disabled: r.CanBeSuspended === false, title: r.CanBeSuspended === false ? 'IRIS marks this process as non-suspendable.' : 'Suspend process', onclick: () => processAction(r, 'suspend', reload) }, 'Suspend'),
            h('button.small', { disabled: !!reason, title: reason || 'Terminate process', onclick: () => processAction(r, 'terminate', reload) }, 'Terminate')];
        } : null,
      }));
    } catch (e) { if (!quiet) clear(box, errorBox(e, reload)); }
    finally { busy = false; }
  };
  const timer = setInterval(() => {
    if (!box.isConnected) { clearInterval(timer); return; }
    if (auto.checked && box.isConnected) reload(true);
  }, 5000);
  filter.addEventListener('keydown', (e) => { if (e.key === 'Enter') reload(); });
  body.append(toolbar(filter, button('Apply filter', () => reload()), button('Refresh', () => reload()),
    h('label.small', auto, ' Auto-refresh (5 s)'),
    can('Operate') ? button('Broadcast message', () => broadcast(reload)) : null), box);
  reload();
}

async function processDetails(row, reload) {
  const content = h('div', h('div.loading', 'Loading…'));
  modal(`Process ${row.Pid}`, content, { wide: true });
  try {
    const detail = await readProcess(row.Pid);
    const reason = safeProcess({ ...row, ...detail });
    clear(content,
      reason ? h('p.muted', `Terminate unavailable: ${reason}`) : null,
      can('Operate') ? toolbar(
        detail.CanBeSuspended !== false ? button('Suspend', () => processAction(row, 'suspend', reload)) : null,
        button('Resume', () => processAction(row, 'resume', reload)),
        !reason ? button('Terminate', () => processAction(row, 'terminate', reload), 'danger') : null) : null,
      kv(detail));
  } catch (e) { clear(content, errorBox(e)); }
}

async function processAction(row, action, reload) {
  if (action === 'terminate') {
    const detail = await readProcess(row.Pid).catch((e) => { toastError(e); return null; });
    if (!detail) return;
    const reason = safeProcess({ ...row, ...detail });
    if (reason) return toastError(new Error(reason));
  }
  const path = `/v2/process/${action}`;
  return confirmAction({
    title: `${action[0].toUpperCase()}${action.slice(1)} process ${row.Pid}`,
    message: action === 'terminate' ? 'The process will stop immediately; its current work may be interrupted.' :
      action === 'suspend' ? 'The process will pause until resumed.' : 'The process will continue running.',
    call: { method: 'POST', path: queryPath(path, { id: row.Pid }), body: {} }, danger: action === 'terminate',
    confirmText: action === 'terminate' ? String(row.Pid) : undefined,
    run: async () => {
      if (action === 'terminate') {
        // A PID can be reused by a new process; job number + user identify the one the user picked.
        // (The routine is not compared: a busy process legitimately moves between routines.)
        const current = await readProcess(row.Pid);
        if (String(current.JobNumber) !== String(row.Job) || current.UserName !== row.Username) {
          throw new Error(`Process ${row.Pid} has changed identity. Refresh the process list before terminating it.`);
        }
      }
      return admin.post(path, {}, { id: row.Pid });
    },
    verify: action === 'terminate' ? { read: () => readProcess(row.Pid), expect: 'gone' } : {
      read: async () => ({ Suspended: /SUSP/i.test(String((await readProcess(row.Pid)).State || '')) }),
      changes: { Suspended: action === 'suspend' },
    },
    done: `Process ${action === 'suspend' ? 'suspended' : action === 'resume' ? 'resumed' : 'terminated'}`,
  }).then((ok) => ok && reload());
}

function broadcast() {
  const message = h('textarea', { rows: 4, placeholder: 'Message to active processes' });
  const pids = h('input', { placeholder: 'Comma-separated process IDs', 'aria-label': 'Process IDs' });
  modal('Broadcast message', [h('p.muted', 'Send to the process IDs you specify.'),
    h('div.form-grid', h('div.field', h('label', 'Message'), message), h('div.field', h('label', 'Process IDs'), pids))], {
    actions: [{ label: 'Cancel', onclick: () => {} }, { label: 'Review call', kind: 'primary', onclick: () => {
      const ids = pids.value.split(',').map((x) => Number(x.trim())).filter(Number.isInteger);
      if (!message.value.trim() || !ids.length) throw new Error('Enter a message and at least one process ID.');
      confirmAction({ title: 'Broadcast message', message: `Send this message to ${ids.length} process(es).`,
        call: { method: 'POST', path: '/api/admin/v2/process/broadcast', body: { Message: message.value, PidList: ids } },
        run: () => admin.post('/v2/process/broadcast', { Message: message.value, PidList: ids }), done: 'Message broadcast' });
    } }],
  });
}

function locksTab(body) {
  const reload = () => load(body, () => admin.get('/v2/locks'), (rows) => [
    toolbar(button('Refresh', reload)), table([
      { key: 'Pid', label: 'PID' }, { key: 'Reference', label: 'Reference' }, { key: 'ModeCount', label: 'Mode' },
      { key: 'Directory', label: 'Directory' }, { key: 'RoutineInfo', label: 'Routine' },
    ], rows || [], { empty: 'No locks.', onRow: (r) => modal(`Lock ${r.Reference}`, kv(r), { wide: true }),
      actions: can('Operate') ? (r) => r.Removable && r.DeleteID ? [button('Remove', () => confirmAction({
        title: 'Remove lock', message: `Remove lock ${r.Reference}? The owning process may lose its synchronization.`,
        call: { method: 'DELETE', path: queryPath('/v2/lock', { id: r.DeleteID }) }, danger: true,
        run: () => admin.del('/v2/lock', { id: r.DeleteID }), done: 'Lock removed',
        verify: { read: () => findInList('/v2/locks', {}, 'DeleteID', r.DeleteID), expect: 'gone' },
      }).then((ok) => ok && reload()), 'small')] : [h('span.muted.small', 'Protected')] : null,
    })]);
  reload();
}

function sessionsTab(body) {
  const reload = () => load(body, () => admin.get('/v2/web-sessions'), (rows) => [
    toolbar(button('Refresh', reload)), table([
      { key: 'ID', label: 'Session' }, { key: 'Username', label: 'User' }, { key: 'Application', label: 'Application' },
      { key: 'Timeout', label: 'Timeout' }, { key: 'SesProcessId', label: 'PID' },
    ], rows || [], { empty: 'No web sessions.', onRow: (r) => modal(`Web session ${r.ID}`, kv(r)),
      actions: can('Operate') ? (r) => r.AllowEndSession ? [button('End', () => confirmAction({
        title: 'End web session', message: `End session ${r.ID} for ${r.Username || 'this user'}? Active requests may be interrupted.`,
        call: { method: 'DELETE', path: queryPath('/v2/web-session', { id: r.ID }) }, danger: true,
        run: () => admin.del('/v2/web-session', { id: r.ID }), done: 'Web session ended',
        verify: { read: () => findInList('/v2/web-sessions', {}, 'ID', r.ID), expect: 'gone' },
      }).then((ok) => ok && reload()), 'small')] : [h('span.muted.small', 'Protected')] : null,
    })]);
  reload();
}
