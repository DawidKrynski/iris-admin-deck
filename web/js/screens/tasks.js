// Task management: list, run / suspend / resume, details & edit, history, upcoming schedule.
import { admin, findInList } from '../api.js';
import { can, navigate } from '../app.js';
import {
  h, page, table, tabs, load, modal, confirmAction, applyVerified, objectForm, diff, kv, badge, toast, toastError,
  apiCallPreview, button, toolbar, clear, icon } from '../ui.js';

const EDITABLE = [
  { key: 'Name', required: true },
  { key: 'Description', type: 'textarea' },
  { key: 'NameSpace', label: 'Namespace' },
  { key: 'TaskClass', label: 'Task class', required: true, help: 'Subclass of %SYS.Task.Definition' },
  { key: 'RunAsUser', label: 'Run as user' },
  { key: 'TimePeriod', label: 'Period', type: 'select', options: ['Daily', 'Weekly', 'Monthly', 'Monthly Special', 'Run After', 'On Demand'] },
  { key: 'TimePeriodEvery', label: 'Every (n periods)', type: 'number' },
  { key: 'DailyFrequency', label: 'Daily frequency', type: 'select', options: ['Once', 'Several'] },
  { key: 'DailyIncrement', label: 'Interval (minutes)', type: 'number' },
  { key: 'DailyStartTime', label: 'Start time', help: 'HH:MM:SS' },
  { key: 'DailyEndTime', label: 'End time', help: 'HH:MM:SS' },
  { key: 'StartDate', label: 'Start date', help: 'YYYY-MM-DD (empty = tomorrow)' },
  { key: 'EndDate', label: 'End date' },
  { key: 'Priority', type: 'select', options: ['Normal', 'Low', 'High'] },
  { key: 'SuspendOnError', label: 'Suspend on error', type: 'bool' },
  { key: 'RescheduleOnStart', label: 'Reschedule on start', type: 'bool' },
  { key: 'Settings', type: 'json', help: 'Task-class specific settings' },
];

// POST /v2/task requires every Task field except Settings; these are the neutral defaults.
const CREATE_DEFAULTS = {
  EmailOnCompletion: [], EmailOnError: [], EmailOnExpiration: [], EmailOutput: false,
  Expires: false, ExpiresDays: '', ExpiresHours: '', ExpiresMinutes: '',
  OutputDirectory: '', OutputFilename: '', OpenOutputFile: false, OutputFileIsBinary: false,
  TimePeriodDay: '', DailyFrequencyTime: '', DailyIncrement: '', DailyEndTime: '', EndDate: '',
  RunAfterGUID: '', MirrorStatus: 'Any', IsBatch: false, SuspendTerminated: false,
};

// Run / suspend / resume need %Admin_Task; create / edit / delete accept %Admin_Operate or %Admin_Task.
const canRun = () => can('Task');
const canEdit = () => can('Operate', 'Task');

export default async function render(el, params) {
  const managerBox = h('div.toolbar');
  el.append(page('Tasks', null,
    managerBox,
    tabs([
      { id: 'tasks', label: 'All tasks', render: (b) => tasksTab(b) },
      { id: 'upcoming', label: 'Upcoming', render: (b) => upcomingTab(b) },
      { id: 'history', label: 'History', render: (b) => historyTab(b) },
    ])));
  managerStatus(managerBox);
  // #/tasks/<id> (e.g. from the command palette) opens that task's details.
  if (params && params[0]) taskDetails(Number(params[0]) || params[0], () => navigate('tasks'));
}

async function managerStatus(box) {
  try {
    const m = await admin.get('/v2/task/manager');
    const running = m.Status === 'Running';
    clear(box, h('span', 'Task Manager: '), badge(m.Status, running ? 'ok' : 'warn'),
      can('Operate', 'Task') ? button(running ? 'Suspend manager' : 'Resume manager', () => confirmAction({
        title: running ? 'Suspend Task Manager' : 'Resume Task Manager',
        message: running ? 'No scheduled task will start until the manager is resumed.' : 'Scheduled tasks will start again.',
        call: { method: 'POST', path: `/api/admin/v2/task/manager/${running ? 'suspend' : 'resume'}`, body: {} },
        danger: running,
        run: () => admin.post(`/v2/task/manager/${running ? 'suspend' : 'resume'}`),
        done: running ? 'Task Manager suspended' : 'Task Manager resumed',
      }).then((ok) => ok && managerStatus(box)), 'small') : null);
  } catch (e) { clear(box, h('span.muted', `Task Manager status unavailable: ${e.message}`)); }
}

function tasksTab(body) {
  const reload = () => load(body, () => admin.get('/v2/tasks'), (rows) => [
    toolbar(canEdit() ? button([icon('plus'), 'New task'], () => editTask(null, reload), 'primary') : null, button('Refresh', reload)),
    table([
      { key: 'Id', label: 'ID', width: '60px' },
      { key: 'Name', label: 'Name', render: (r) => h('div', h('strong', r.Name), h('div.muted.small', r.Description || '')) },
      { key: 'Namespace', label: 'Namespace' },
      { key: 'Type', label: 'Type', render: (r) => badge(r.Type || '—') },
      { key: 'Suspended', label: 'State', render: (r) => (r.Suspended ? badge('Suspended', 'warn') : badge('Active', 'ok')) },
      { key: 'LastFinished', label: 'Last finished' },
      { key: 'NextScheduled', label: 'Next run' },
    ], rows, {
      sortKey: 'Id',
      onRow: (r) => taskDetails(r.Id, reload),
      actions: canRun() ? (r) => [
        h('button.small', { title: 'Run now', onclick: () => runTask(r) }, icon('play'), 'Run'),
        r.Suspended
          ? h('button.small', { onclick: () => setSuspended(r, false, reload) }, 'Resume')
          : h('button.small', { onclick: () => setSuspended(r, true, reload) }, 'Suspend'),
      ] : null,
    }),
  ]);
  reload();
}

export function runTask(t) {
  return confirmAction({
    title: `Run “${t.Name}” now`,
    message: 'The task will be queued immediately, in addition to its normal schedule.',
    call: { method: 'POST', path: `/api/admin/v2/task/run?id=${t.Id}`, body: { RunNow: true } },
    confirmLabel: 'Run now',
    run: () => admin.post('/v2/task/run', { RunNow: true }, { id: t.Id }),
    done: `Task “${t.Name}” started. The result appears under History.`,
  });
}

function setSuspended(t, suspend, reload) {
  const action = suspend ? 'suspend' : 'resume';
  const body = suspend ? { LeaveInQueue: true } : {};
  return confirmAction({
    title: `${suspend ? 'Suspend' : 'Resume'} “${t.Name}”`,
    message: suspend ? 'The task will not run until it is resumed.' : 'The task will run again on its schedule.',
    call: { method: 'POST', path: `/api/admin/v2/task/${action}?id=${t.Id}`, body },
    danger: suspend,
    run: () => admin.post(`/v2/task/${action}`, body, { id: t.Id }),
    verify: { read: () => admin.get('/v2/task/info', { id: t.Id }), changes: { Suspended: suspend } },
    done: `Task ${suspend ? 'suspended' : 'resumed'}`,
  }).then((ok) => ok && reload());
}

async function taskDetails(id, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(`Task #${id}`, body, { wide: true });
  try {
    const [task, info, history] = await Promise.all([
      admin.get('/v2/task', { id }),
      admin.get('/v2/task/info', { id }).catch(() => null),
      admin.get('/v2/task/history', { taskId: id, maxRows: 20 }).catch(() => []),
    ]);
    const failures = history.filter((x) => x.ErrNumber || /error/i.test(x.Result || ''));
    clear(body,
      toolbar(
        canRun() ? button([icon('play'), 'Run now'], () => runTask({ Id: id, Name: task.Name }), 'primary') : null,
        canEdit() ? button('Edit', () => { m.close(); editTask({ ...task, Id: id }, reload); }) : null,
        !canEdit() ? null : button('Delete', () => confirmAction({
          title: `Delete task “${task.Name}”`,
          message: 'This removes the task definition permanently.',
          call: { method: 'DELETE', path: `/api/admin/v2/task?id=${id}` },
          danger: true,
          confirmLabel: 'Delete',
          confirmText: task.Name,
          run: () => admin.del('/v2/task', { id }),
          verify: { read: () => admin.get('/v2/task', { id }), expect: 'gone' },
          done: 'Task deleted',
        }).then((ok) => { if (ok) { m.close(); reload(); } })),
        button('Show in timeline', () => { m.close(); navigate(`logs/timeline/${encodeURIComponent(task.Name)}`); }),
      ),
      failures.length ? h('div.error-box', h('strong', `${failures.length} of the last ${history.length} runs reported errors`),
        h('p', failures[0].Result || `Error ${failures[0].ErrNumber}`)) : null,
      h('h3', 'Recent runs'),
      historyTable(history),
      info ? [h('h3', 'Runtime info'), kv(info)] : null,
      h('h3', 'Definition'),
      kv(task));
  } catch (e) { clear(body, h('div.error-box', e.message)); }
}

function historyTable(rows) {
  return table([
    { key: 'LastStart', label: 'Started' },
    { key: 'Completed', label: 'Completed' },
    { key: 'Name', label: 'Task' },
    { key: 'Status', label: 'Status', render: (r) => (r.ErrNumber ? badge('Error', 'err') : r.Status === '1' || r.Status === 1 ? badge('OK', 'ok') : badge(String(r.Status || '—'))) },
    { key: 'Result', label: 'Result', render: (r) => h('span.small', r.Result || '') },
    { key: 'Username', label: 'User' },
  ], rows, { sortKey: 'LastStart', empty: 'No runs recorded yet.', pageSize: 50 });
}

function historyTab(body) {
  const reload = () => load(body, () => admin.get('/v2/task/history', { maxRows: 500 }), (rows) => [
    toolbar(button('Refresh', reload)),
    historyTable(rows.slice().reverse()),
  ]);
  reload();
}

function upcomingTab(body) {
  const reload = () => load(body, () => admin.get('/v2/task/upcoming'), (rows) => [
    toolbar(button('Refresh', reload)),
    table([
      { key: 'Datetime', label: 'When' },
      { key: 'Name', label: 'Task' },
      { key: 'Namespace', label: 'Namespace' },
      { key: 'Suspended', label: 'State', render: (r) => (r.Suspended ? badge('Suspended', 'warn') : badge('Scheduled', 'ok')) },
    ], rows, { sortKey: 'Datetime', empty: 'Nothing scheduled.' }),
  ]);
  reload();
}

function editTask(task, reload) {
  const isNew = !task;
  const initial = task || {
    Name: '', NameSpace: 'USER', TaskClass: '', RunAsUser: '_SYSTEM', TimePeriod: 'Daily', TimePeriodEvery: 1,
    DailyFrequency: 'Once', DailyStartTime: '02:00:00', Priority: 'Normal', SuspendOnError: false, RescheduleOnStart: true,
    Description: '', Settings: {},
  };
  const form = objectForm(initial, EDITABLE);
  const preview = h('div');
  const buildCall = () => {
    const value = form.value();
    const payload = isNew ? { ...CREATE_DEFAULTS, ...value } : diff(task, value);
    // IRIS rejects a first run in the past, so an empty start date means "from tomorrow".
    if (isNew && !payload.StartDate) payload.StartDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return { method: isNew ? 'POST' : 'PUT', path: `/api/admin/v2/task${isNew ? '' : `?id=${task.Id}`}`, body: payload };
  };
  modal(isNew ? 'New task' : `Edit task #${task.Id}`, [form.el, h('div.toolbar', button('Preview API call', () => {
    try { const c = buildCall(); clear(preview, apiCallPreview(c.method, c.path, c.body)); } catch (e) { toastError(e); }
  }, 'small')), preview], {
    wide: true,
    actions: [
      { label: 'Cancel', onclick: () => {} },
      {
        label: isNew ? 'Create task' : 'Save changes',
        kind: 'primary',
        onclick: async () => {
          const c = buildCall();
          if (!isNew && !Object.keys(c.body).length) { toast('No changes', 'warn'); return false; }
          if (isNew) {
            // POST /v2/task does not return the new id, so the created task is found again by name.
            await applyVerified({ write: () => admin.post('/v2/task', c.body), read: () => findInList('/v2/tasks', { filter: c.body.Name }, 'Name', c.body.Name), expect: 'exists' }, 'Task created');
          } else {
            const { Id, ...original } = task;
            await applyVerified({
              original, changes: c.body,
              read: () => admin.get('/v2/task', { id: Id }),
              write: () => admin.put('/v2/task', c.body, { id: Id }),
            }, 'Task saved');
          }
          reload();
          return true;
        },
      },
    ],
  });
}
