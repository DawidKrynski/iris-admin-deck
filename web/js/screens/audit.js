import { admin, waitAsync } from '../api.js';
import { can } from '../app.js';
import { h, page, table, tabs, load, modal, confirmAction, kv, badge, button, toolbar, clear, errorBox } from '../ui.js';

const queryPath = (path, query) => `/api/admin${path}?${new URLSearchParams(query)}`;
const isAsync = (r) => !!r && !Array.isArray(r) && !!(r.GUID || r.Id || r.id);
const readAuditState = () => admin.get('/v2/security/audit/enabled');
const readAuditEvent = (query) => admin.get('/v2/security/audit/event', query);

export default async function render(el, params) {
  const status = h('div.toolbar');
  el.append(page('Audit trail', 'Search security events and see what is recorded.', status,
    tabs([{ id: 'records', label: 'Records', render: recordsTab },
      { id: 'events', label: 'Events', render: eventsTab }], params[0])));
  statusPanel(status);
}

async function statusPanel(box) {
  try {
    const result = await readAuditState();
    const enabled = !!result.Enabled;
    // Switching auditing off is deliberately not offered here: it only ever weakens the instance.
    clear(box, h('span', 'Auditing: '), badge(enabled ? 'Enabled' : 'Disabled', enabled ? 'ok' : 'warn'),
      !enabled && can('Secure') ? button('Enable auditing', () => confirmAction({
        title: 'Enable auditing', message: 'New audit records will be captured.',
        call: { method: 'PUT', path: '/api/admin/v2/security/audit/enabled', body: { Enabled: true } },
        run: () => admin.put('/v2/security/audit/enabled', { Enabled: true }),
        verify: { read: readAuditState, changes: { Enabled: true } }, done: 'Auditing enabled',
      }).then((ok) => ok && statusPanel(box)), 'small') : null);
  } catch (e) { clear(box, errorBox(e, () => statusPanel(box))); }
}

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
    await load(resultBox, async () => {
      const result = await admin.post('/v2/security/audit/records', {}, query);
      if (!isAsync(result)) return result;
      // The query runs as a background task that usually finishes in well under a second: poll quickly.
      return waitAsync(result.GUID || result.Id || result.id, { interval: 300, timeoutMs: 3 * 60 * 1000 });
    }, (result) => {
      const rows = Array.isArray(result) ? result : Array.isArray(result?.Result) ? result.Result :
        Array.isArray(result?.Result?.Records) ? result.Result.Records : [];
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

async function recordDetails(row) {
  const q = { utcTimeStamp: row.UTCTimeStamp, systemID: row.SystemID, auditIndex: row.AuditIndex };
  const content = h('div', h('div.loading', 'Loading…'));
  modal(`Audit record ${row.AuditIndex}`, content, { wide: true });
  try { clear(content, kv(await admin.get('/v2/security/audit/record', q))); }
  catch (e) { clear(content, errorBox(e)); }
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
