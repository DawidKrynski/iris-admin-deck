import { admin, ext, waitAsync } from '../api.js';
import { can } from '../app.js';
import { h, page, table, tabs, load, modal, confirmAction, kv, badge, button, toolbar, clear, errorBox, toast, toastError } from '../ui.js';
import { purgeCutoff, checkPurge, countLabel, auditRows } from '../retention.js';
import { outcomeKind, changesCsv } from '../changes.js';

const queryPath = (path, query) => `/api/admin${path}?${new URLSearchParams(query)}`;
const isAsync = (r) => !!r && !Array.isArray(r) && !!(r.GUID || r.Id || r.id);
const readAuditState = () => admin.get('/v2/security/audit/enabled');
const readAuditEvent = (query) => admin.get('/v2/security/audit/event', query);

export default async function render(el, params) {
  const status = h('div.toolbar');
  el.append(page('Audit trail', null, status,
    tabs([{ id: 'records', label: 'Records', render: recordsTab },
      { id: 'events', label: 'Events', render: eventsTab },
      can('Secure', 'Operate') ? { id: 'changes', label: 'Changes made here', render: changesTab } : null,
      can('Secure') ? { id: 'maintenance', label: 'Maintenance', render: maintenanceTab } : null].filter(Boolean), params[0])));
  statusPanel(status);
}

async function statusPanel(box) {
  try {
    const result = await readAuditState();
    const enabled = !!result.Enabled;
    // No switch to turn auditing off: use SMP or the API console for that.
    clear(box, h('span', 'Auditing: '), badge(enabled ? 'Enabled' : 'Disabled', enabled ? 'ok' : 'warn'),
      !enabled && can('Secure') ? button('Enable auditing', () => confirmAction({
        title: 'Enable auditing', message: 'New audit records will be captured.',
        call: { method: 'PUT', path: '/api/admin/v2/security/audit/enabled', body: { Enabled: true } },
        run: () => admin.put('/v2/security/audit/enabled', { Enabled: true }),
        verify: { read: readAuditState, changes: { Enabled: true } }, done: 'Auditing enabled',
      }).then((ok) => ok && statusPanel(box)), 'small') : null);
  } catch (e) { clear(box, errorBox(e, () => statusPanel(box))); }
}

async function queryRecords(query) {
  const result = await admin.post('/v2/security/audit/records', {}, query);
  if (!isAsync(result)) return result;
  // The query runs as a background task that usually finishes in well under a second: poll quickly.
  return waitAsync(result.GUID || result.Id || result.id, { label: 'Audit records', interval: 300, timeoutMs: 3 * 60 * 1000 });
}
const recordRows = (result) => (Array.isArray(result) ? result : Array.isArray(result?.Result) ? result.Result :
  Array.isArray(result?.Result?.Records) ? result.Result.Records : []);

function recordsTab(body) {
  // Empty range = from the first to the last record (newest first, max 500). Dates are server time,
  // which is usually not the browser's time zone, so no browser-clock defaults.
  const fields = [
    ['beginDateTime', 'From (server time, YYYY-MM-DD HH:MM:SS)', ''],
    ['endDateTime', 'To (server time)', ''], ['events', 'Event names', ''], ['usernames', 'Users', ''],
    ['eventSources', 'Sources', ''], ['eventTypes', 'Types', ''], ['namespaces', 'Namespaces', ''],
  ];
  const inputs = Object.fromEntries(fields.map(([key, label, value]) => [key, h('input', { value, 'aria-label': label })]));
  const resultBox = h('div');
  const search = async () => {
    const query = Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.value.trim()]).filter(([, value]) => value));
    query.maxRows = 500;
    query.ascending = 0;
    await load(resultBox, () => queryRecords(query), (result) => {
      const rows = recordRows(result);
      return [isAsync(result) && !/finish|complete/i.test(String(result.State)) ? h('div.card', h('strong', `Task ${result.GUID || result.Id || result.id}: ${result.State}`),
        result.FailureReason ? h('p', result.FailureReason) : null) : null,
      table([
        { key: 'UTCTimeStamp', label: 'Time (UTC)' }, { key: 'EventSource', label: 'Source' },
        { key: 'EventType', label: 'Type' }, { key: 'Event', label: 'Event' },
        { key: 'Username', label: 'User' }, { key: 'Pid', label: 'PID' },
        { key: 'Description', label: 'Description' },
      ], rows, { empty: 'No audit records in this range.', onRow: recordDetails, pageSize: 50 })];
    });
  };
  body.append(h('div.card', h('div.form-grid', fields.map(([key, label]) => h('div.field', h('label', label), inputs[key]))),
    toolbar(button('Search records', search, 'primary'))), resultBox);
  search();
}

// ---------- maintenance: size, copy to a namespace, purge old records ----------
// Counting reads the matching records (the API has no count call), capped so a huge trail stays cheap.
// auditRows() throws for a failed, cancelled or malformed query: a count is never a guess.
const COUNT_CAP = 10000;
const countRecords = async (range) => auditRows(await queryRecords({ ...range, maxRows: COUNT_CAP, ascending: 1 })).length;
const edgeRecord = async (ascending) => auditRows(await queryRecords({ maxRows: 1, ascending }))[0] || null;
const localTime = (r) => r && (r.TimeStamp || r.UTCTimeStamp || '');

function maintenanceTab(body) {
  const summary = h('div');
  const reload = () => load(summary, async () => {
    const [dbs, dirs, oldest, last] = await Promise.all([admin.get('/v2/databases'), admin.get('/v2/database-dirs'),
      edgeRecord(1), edgeRecord(0)]);
    const db = (dbs || []).find((d) => d.Name === 'IRISAUDIT');
    const dir = db && (dirs || []).find((d) => d.Directory === db.Directory);
    return { db, dir, oldest, last };
  }, ({ db, dir, oldest, last }) => {
    const newest = localTime(last);
    return h('div.card', h('h2', 'Audit database'), kv({
      Database: db ? `IRISAUDIT (${db.Directory})` : 'IRISAUDIT',
      Size: dir?.Size !== undefined ? `${dir.Size} MB` : 'not available',
      'Oldest record': localTime(oldest) || '—', 'Newest record': newest || '—',
    }), toolbar(button('Refresh', reload, 'small')));
  });
  body.append(h('div.grid.wide', summary, copyCard(), purgeCard(reload)));
  reload();
}

function copyCard() {
  const ns = h('select', { 'aria-label': 'Target namespace' });
  const from = h('input', { placeholder: 'YYYY-MM-DD HH:MM:SS, empty = first record', 'aria-label': 'From (server time)' });
  const to = h('input', { placeholder: 'empty = last record', 'aria-label': 'To (server time)' });
  admin.get('/v2/namespaces').then((rows) => clear(ns, (rows || []).map((r) => r.Name || r).filter((n) => !String(n).startsWith('%'))
    .map((n) => h('option', { value: n, selected: n === 'USER' }, n))), toastError);
  const run = async () => {
    const body = { AuditCopyNamespace: ns.value, DeleteAfterCopy: false, BeginDateTime: from.value.trim(), EndDateTime: to.value.trim() };
    if (!body.AuditCopyNamespace) throw new Error('Choose a target namespace.');
    const range = { beginDateTime: body.BeginDateTime, endDateTime: body.EndDateTime };
    const count = await countRecords(range);
    if (!count) return toast('No audit records in this range.', 'warn');
    return confirmAction({ title: `Copy audit records to ${body.AuditCopyNamespace}`,
      message: `${countLabel(count, COUNT_CAP)} records will be copied. The audit trail itself is not changed.`,
      call: { method: 'POST', path: '/api/admin/v2/security/audit/record/copy', body }, confirmLabel: 'Copy',
      run: async () => {
        await finish(await admin.post('/v2/security/audit/record/copy', body), 'Copy audit records');
        // The copy is not readable through the API; confirm at least that the source kept its records.
        const kept = await countRecords(range);
        toast(kept >= count ? `Copy finished. ${countLabel(kept, COUNT_CAP)} records still in IRISAUDIT.` :
          `Copy finished, but only ${kept} records remain in the range`, kept >= count ? 'ok' : 'warn');
      } });
  };
  return h('div.card', h('h2', 'Copy records to a namespace'),
    h('p.muted.small', 'Export audit records into another namespace (for example before purging). Leave the dates empty for the whole trail.'),
    h('div.form-grid', h('div.field', h('label', 'Target namespace'), ns),
      h('div.field', h('label', 'From (server time)'), from), h('div.field', h('label', 'To (server time)'), to)),
    toolbar(button('Copy…', () => run().catch(toastError))));
}

function purgeCard(reload) {
  const days = h('input', { type: 'number', min: 1, step: 1, value: 365, 'aria-label': 'Older than (days)' });
  const run = async () => {
    // Read fresh, right before confirming: the server's own clock (records are stamped in server time,
    // never the browser's; /whoami needs no %Admin_Operate) and the newest record, which must lie after
    // the cutoff. Either read failing stops the purge.
    const [me, last] = await Promise.all([ext.get('/whoami'), edgeRecord(0)]);
    const cutoff = purgeCutoff(days.value, me && me.serverTime);
    const body = checkPurge(cutoff, localTime(last));
    const range = { beginDateTime: '', endDateTime: cutoff };
    const count = await countRecords(range);
    if (!count) return toast(`No audit records before ${cutoff}.`, 'warn');
    const ok = await confirmAction({ title: 'Purge old audit records', danger: true, confirmLabel: 'Purge',
      message: `${countLabel(count, COUNT_CAP)} audit records older than ${cutoff} will be permanently deleted. Copy them to a namespace first if you need to keep them.`,
      confirmText: String(count), call: { method: 'POST', path: '/api/admin/v2/security/audit/record/purge', body },
      run: async () => {
        await finish(await admin.post('/v2/security/audit/record/purge', body), 'Purge audit records');
        const left = await countRecords(range);
        toast(left ? `Purge accepted, but ${left} records before ${cutoff} remain` : 'Records purged. Read back: none left before the cutoff.', left ? 'warn' : 'ok');
      } });
    if (ok) reload();
  };
  return h('div.card', h('h2', 'Purge old records'),
    h('p.muted.small', 'Deletes records older than the given number of days. The newest records are never touched; you type the number of records to confirm.'),
    h('div.form-grid', h('div.field', h('label', 'Older than (days)'), days)),
    toolbar(button('Purge…', () => run().catch(toastError), 'danger')));
}

/** Waits for a queued copy/purge and fails when the background task did. */
async function finish(result, label) {
  const task = isAsync(result) ? await waitAsync(result.GUID || result.Id || result.id, { label, interval: 500 }) : result;
  if (task && /fail|error|cancel/i.test(String(task.State || ''))) throw new Error(task.FailureReason || `Background task ${task.State}`);
  return task;
}

async function recordDetails(row) {
  const q = { utcTimeStamp: row.UTCTimeStamp, systemID: row.SystemID, auditIndex: row.AuditIndex };
  const content = h('div', h('div.loading', 'Loading…'));
  modal(`Audit record ${row.AuditIndex}`, content, { wide: true });
  try { clear(content, kv(await admin.get('/v2/security/audit/record', q))); }
  catch (e) { clear(content, errorBox(e)); }
}

// ---------- changes made through Admin Deck (AdminDeck.Changes) ----------
const CHANGES_SHOWN = 1000;
// Display only: the stored path stays encoded as sent.
const readablePath = (path) => { try { return decodeURIComponent(path); } catch { return path; } };

function changesTab(body) {
  const list = h('div');
  const reload = () => load(list, () => ext.get('/changes', { limit: CHANGES_SHOWN }), (rows) => table([
    { key: 'time', label: 'Time (server)', width: '11rem' },
    { key: 'user', label: 'User' },
    { key: 'what', label: 'What' },
    { key: 'outcome', label: 'Read back', render: (r) => h('span', { title: r.details || null }, badge(r.outcome, outcomeKind(r.outcome))) },
    { key: 'calls', label: 'Calls', sort: (r) => (r.calls || []).map((c) => `${c.method} ${readablePath(c.path)}`).join(' '),
      render: (r) => (r.calls || []).length ? h('div.calls', r.calls.map((c) => h('div', h('code', `${c.method} ${readablePath(c.path)}`)))) : '—' },
  ], rows || [], { empty: 'No changes recorded yet.', pageSize: 50, placeholder: 'Filter by user, change, outcome or path…',
    tools: [button('Refresh', reload, 'small'),
      button('CSV', () => download('admin-deck-changes.csv', 'text/csv', changesCsv(rows)), 'small'),
      button('JSON', () => download('admin-deck-changes.json', 'application/json', JSON.stringify(rows || [], null, 2)), 'small')] }));
  body.append(h('p.muted.small', 'Changes made through Admin Deck, newest first, with the outcome of reading them back (hover a badge for details). ',
    'Only the method and path of each call are kept, never a request body. The IRIS security audit (Records) remains the authoritative record: ',
    'this log does not see changes made in SMP, by code or through the API directly.'), list);
  reload();
}

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  h('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function eventsTab(body) {
  const reload = () => load(body, () => admin.get('/v2/security/audit/events'), (rows) => [
    toolbar(button('Refresh', reload)), table([
      { key: 'EventName', label: 'Event' },
      { key: 'Enabled', label: 'Status', render: (r) => badge(r.Enabled ? 'Enabled' : 'Disabled', r.Enabled ? 'ok' : 'muted') },
      { key: 'Total', label: 'Total' }, { key: 'Written', label: 'Written' }, { key: 'Lost', label: 'Lost' },
    ], rows || [], { empty: 'No audit event definitions.',
      actions: can('Secure') ? (r) => [button(r.Enabled ? 'Disable' : 'Enable', () => toggleEvent(r, reload), 'small')] : null,
    })]);
  reload();
}

function toggleEvent(row, reload) {
  const parts = String(row.EventName || '').split('/');
  if (parts.length < 3) return modal('Event identifier unavailable', h('p', 'This event name does not provide source, type and name.'));
  const query = { source: parts[0], type: parts[1], name: parts.slice(2).join('/') };
  const body = { Enabled: !row.Enabled };
  return confirmAction({ title: `${row.Enabled ? 'Disable' : 'Enable'} ${row.EventName}`,
    message: row.Enabled ? 'Future occurrences of this event will not be written to the audit trail.' : 'Future occurrences of this event will be recorded.',
    call: { method: 'PUT', path: queryPath('/v2/security/audit/event', query), body }, danger: row.Enabled,
    run: () => admin.put('/v2/security/audit/event', body, query), done: 'Audit event updated',
    verify: { read: () => readAuditEvent(query), changes: body },
  }).then((ok) => ok && reload());
}
