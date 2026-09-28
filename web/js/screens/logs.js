// Logs & insights: viewer for current and rotated IRIS log files, recurring-problem patterns,
// and "find similar incidents" backed by IRIS Vector Search. Served by the /admindeck/api extension.
import { admin, ext, waitAsync } from '../api.js';
import { can, navigate } from '../app.js';
import {
  h, clear, page, tabs, table, load, badge, severityBadge, fmtBytes, button, toast, toastError, loading, errorBox, copy,
} from '../ui.js';
import { dismountedDirs, dismountedIn, loginFailureBursts, nextSteps, openLink, stepButton, mountStep, runAgainStep } from '../actions.js';

const PAGE = 200;

export default async function render(el, params) {
  const [first, qParam] = params || [];
  // #/logs/timeline/<text>: timeline filtered by <text>; #/logs/viewer|insights|similar: that tab;
  // #/logs/<file>/<text>: log viewer on <file> filtered by <text>.
  const tab = ['viewer', 'insights', 'similar'].includes(first) ? first : null;
  const fileParam = tab ? null : first;
  const timelineQuery = fileParam === 'timeline' ? (qParam || '') : null;
  const state = { file: fileParam && fileParam !== 'timeline' ? fileParam : 'messages', q: timelineQuery === null ? (qParam || '') : '', severity: 0, source: '', offset: 0, files: [] };
  let files = [];
  try { files = await ext.get('/logs/files'); } catch (e) { el.append(page('Logs & insights', null, errorBox(e))); return; }
  state.files = files;
  if (!files.some((f) => f.key === state.file)) state.file = 'messages';

  const body = h('div');
  el.append(page('Logs & insights', null, body));
  let similarQuery = tab === 'similar' ? (qParam || '') : '';
  const t = tabs([
    { id: 'timeline', label: 'Timeline', render: (b) => timeline(b, timelineQuery || '', (text) => { similarQuery = text; switchTab('similar'); }) },
    { id: 'viewer', label: 'Log viewer', render: (b) => viewer(b, state, (text) => { similarQuery = text; switchTab('similar'); }) },
    { id: 'insights', label: 'Recurring problems', render: (b) => insights(b, state, (pattern) => { state.q = pattern; state.offset = 0; switchTab('viewer'); }) },
    { id: 'similar', label: 'Similar incidents', render: (b) => similar(b, state, similarQuery) },
  ], tab || (timelineQuery !== null || !fileParam ? 'timeline' : 'viewer'));
  body.append(t);
  function switchTab(id) { t.querySelector(`.tab[data-id="${id}"]`).click(); }
}

function fileSelect(state, onchange) {
  const current = state.files.filter((f) => !f.rotated);
  const rotated = state.files.filter((f) => f.rotated);
  return h('select', { 'aria-label': 'Log file', onchange: (e) => { state.file = e.target.value; state.offset = 0; onchange(); } },
    h('optgroup', { label: 'Current' }, current.map((f) => h('option', { value: f.key, selected: f.key === state.file, disabled: !f.exists },
      `${f.name}${f.exists ? ` (${fmtBytes(f.size)})` : ' (not present)'}`))),
    rotated.length ? h('optgroup', { label: 'Rotated (older)' }, rotated.map((f) => h('option', { value: f.key, selected: f.key === state.file },
      `${f.name} · ${String(f.modified).slice(0, 16)} (${fmtBytes(f.size)})`))) : null);
}

function viewer(box, state, onSimilar) {
  const list = h('div.log-list.table-wrap');
  const summary = h('div.muted.small');
  const sourceSel = h('select', { 'aria-label': 'Source', onchange: (e) => { state.source = e.target.value; state.offset = 0; fetchLines(); } });
  const search = h('input', {
    type: 'search', placeholder: 'Search text…', value: state.q, 'aria-label': 'Search log text',
    onkeydown: (e) => { if (e.key === 'Enter') { state.q = search.value; state.offset = 0; fetchLines(); } },
  });
  const chips = h('div.chips', [['All', 0], ['Warnings+', 1], ['Errors+', 2]].map(([label, sev]) => h(`button.chip${state.severity === sev ? '.active' : ''}`, {
    onclick: (e) => {
      state.severity = sev; state.offset = 0;
      for (const c of chips.children) c.classList.toggle('active', c === e.currentTarget);
      fetchLines();
    },
  }, label)));
  const more = h('div.pager');
  const rotatedCount = state.files.filter((f) => f.rotated).length;
  clear(box,
    h('div.idea-note.small', `Older rotated logs (messages.old_*, alerts.old_*) are listed under “Rotated”${rotatedCount ? ` (${rotatedCount} found)` : ''}. `,
      h('a', { href: 'https://ideas.intersystems.com/ideas/DPI-I-966', target: '_blank', rel: 'noopener' }, 'Ideas portal DPI-I-966')),
    h('div.log-controls', fileSelect(state, () => fetchLines(true)), chips, search, sourceSel,
      button('Search', () => { state.q = search.value; state.offset = 0; fetchLines(); }, 'primary')),
    summary, list, more);

  async function fetchLines(resetSource) {
    if (resetSource) state.source = '';
    if (state.offset === 0) clear(list, loading());
    try {
      const res = await ext.get(`/logs/${encodeURIComponent(state.file)}`, { severity: state.severity, q: state.q, source: state.source, limit: PAGE, offset: state.offset });
      clear(sourceSel, h('option', { value: '' }, 'All sources'), (res.sources || []).map((s) => h('option', { value: s, selected: s === state.source }, s)));
      const c = res.counts || {};
      clear(summary, `${res.total} matching entries · file ${fmtBytes(res.size)} · `,
        badge(`${c.info || 0} info`), ' ', badge(`${c.warning || 0} warnings`, c.warning ? 'warn' : ''), ' ',
        badge(`${(c.severe || 0) + (c.fatal || 0)} errors`, c.severe || c.fatal ? 'err' : ''));
      const rows = (res.entries || []).map((e) => h(`div.log-line.sev-${e.severity}`, { tabindex: 0 },
        h('span.muted', e.ts || '—'),
        severityBadge(e.severity),
        h('span.muted', `pid ${e.pid}`),
        h('span', e.source),
        h('span.msg', e.message),
        h('div.line-actions',
          h('button.small', { onclick: () => onSimilar(`${e.source} ${e.message}`) }, 'Find similar incidents'), ' ',
          h('button.small', { onclick: () => copy(`${e.ts} (${e.pid}) ${e.severity} [${e.source}] ${e.message}`) }, 'Copy line'))));
      if (state.offset === 0) clear(list, rows.length ? rows : h('div.empty-state', 'No entries match these filters.'));
      else list.append(...rows);
      const shown = state.offset + (res.entries || []).length;
      clear(more, shown < res.total ? button(`Load older entries (${res.total - shown} more)`, () => { state.offset = shown; fetchLines(); }) : []);
    } catch (e) { clear(list, errorBox(e, () => fetchLines())); }
  }
  fetchLines();
}

function insights(box, state, onPattern) {
  const out = h('div');
  const sevSel = h('select', { 'aria-label': 'Minimum severity', onchange: () => run() },
    h('option', { value: 1 }, 'Warnings and errors'), h('option', { value: 2 }, 'Errors only'), h('option', { value: 0 }, 'Everything'));
  clear(box,
    h('p.muted', 'Numbers, paths and quoted values are masked, and identical messages are counted once. Sorted by severity, then count.'),
    h('div.toolbar', fileSelect(state, () => run()), sevSel), out);
  const run = () => load(out, () => ext.get(`/logs/${encodeURIComponent(state.file)}/insights`, { severity: sevSel.value, top: 50 }), (res) => [
    h('p.muted.small', `${res.distinct} distinct patterns in ${fmtBytes(res.size)} of log.`),
    table([
      { key: 'maxSeverity', label: 'Severity', render: (r) => severityBadge(r.maxSeverity), width: '90px' },
      { key: 'count', label: 'Count', width: '70px' },
      { key: 'pattern', label: 'Pattern', render: (r) => h('div', h('div', r.example), h('div.muted.small.mono', r.pattern)) },
      { key: 'source', label: 'Source' },
      { key: 'last', label: 'Last seen' },
      { key: 'first', label: 'First seen' },
    ], res.patterns || [], {
      filter: false,
      empty: 'No recurring problems at this severity.',
      actions: (r) => [h('button.small', { onclick: () => onPattern(r.example.split(/\s+/).slice(0, 4).join(' ')) }, 'Show entries')],
    }),
  ]);
  run();
}

function similar(box, state, initialQuery) {
  const status = h('div.toolbar');
  const results = h('div');
  const q = h('textarea', { rows: 3, placeholder: 'Paste an error message, e.g. “Error opening file … permission denied”', 'aria-label': 'Incident text' }, initialQuery || '');
  const scope = h('select', { 'aria-label': 'Scope' }, h('option', { value: '' }, 'All indexed files'),
    state.files.filter((f) => f.exists).map((f) => h('option', { value: f.key }, f.name)));
  const minSev = h('select', { 'aria-label': 'Minimum severity' }, h('option', { value: 0 }, 'Any severity'), h('option', { value: 1 }, 'Warnings+'), h('option', { value: 2 }, 'Errors+'));
  clear(box,
    h('p.muted', 'Matches by wording (hashed words and character trigrams, HNSW index), not by meaning. Rebuild the index after the log rotates.'),
    status,
    h('div.field.span', h('label', 'Describe or paste an incident'), q),
    h('div.toolbar', { style: { marginTop: '8px' } }, scope, minSev, button('Find similar', () => search(), 'primary')),
    results);

  const drawStatus = async () => {
    clear(status, loading('Checking index…'));
    try {
      const st = await ext.get('/search/status');
      const keys = Object.keys(st);
      clear(status,
        h('span', 'Indexed: '),
        keys.length ? keys.map((k) => [badge(`${k}: ${st[k].count}`, 'ok'), ' ']) : badge('nothing yet', 'warn'),
        fileSelect(state, () => {}),
        button('Build / refresh index for selected file', async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            const r = await ext.post(`/logs/${encodeURIComponent(state.file)}/index`);
            toast(`Indexed ${r.indexed} entries from ${r.file}`);
            drawStatus();
          } catch (e) { toastError(e); } finally { btn.disabled = false; }
        }, 'small'));
      if (!keys.length && !initialQuery) clear(results, h('div.empty-state', 'Build the index for a log file to start searching.'));
      return keys.length;
    } catch (e) { clear(status, errorBox(e)); return 0; }
  };

  async function search() {
    const text = q.value.trim();
    if (!text) { toast('Enter some text to search for', 'warn'); return; }
    clear(results, loading('Searching…'));
    try {
      const hits = await ext.get('/search/similar', { q: text, file: scope.value, k: 50, severity: minSev.value });
      // Collapse identical messages (same text, same file) into one row with a count.
      const byKey = new Map();
      for (const r of hits) {
        const key = `${r.file}|${r.source}|${r.message}`;
        const g = byKey.get(key);
        if (g) { g.count++; if (r.ts > g.ts) g.ts = r.ts; } else byKey.set(key, { ...r, count: 1 });
      }
      const rows = [...byKey.values()].slice(0, 20);
      clear(results, table([
        { key: 'score', label: 'Similarity', render: (r) => h('span.score', Number(r.score).toFixed(3)), sort: (r) => Number(r.score), width: '90px' },
        { key: 'severity', label: 'Sev', render: (r) => severityBadge(r.severity), width: '80px' },
        { key: 'ts', label: 'Last seen' },
        { key: 'count', label: 'Hits', width: '60px' },
        { key: 'source', label: 'Source' },
        { key: 'message', label: 'Message', render: (r) => h('span.msg', r.message) },
        { key: 'file', label: 'File' },
      ], rows, {
        filter: false,
        empty: 'Nothing indexed yet. Build the index first.',
        onRow: (r) => navigate(`logs/${encodeURIComponent(r.file)}/${encodeURIComponent(r.message.split(/\s+/).slice(0, 5).join(' '))}`),
      }));
    } catch (e) { clear(results, errorBox(e)); }
  }

  drawStatus().then((n) => { if (initialQuery && n) search(); });
}

// ---------- Timeline: one chronological view across subsystems ----------
// Audit events worth a warning colour in the timeline.
const AUDIT_WARN = /LoginFailure|Protect|UserChange|RoleChange|ResourceChange|ServiceChange|ApplicationChange|DBAudit|AuditChange|SSLConfigChange|Terminate/i;

const logSource = (id, label) => ({
  id, label,
  // Severity is filtered on the server so warnings are not crowded out of the 300-entry window.
  load: async (minSeverity) => ((await ext.get(`/logs/${id}`, { severity: minSeverity, limit: 300 })).entries || []).map((e) => ({
    ts: e.ts, severity: e.severity, title: `[${e.source}] ${e.message.split('\n')[0]}`, detail: e.message.includes('\n') ? e.message : '',
  })),
});

// Every source of "what happened" on the instance. `needs` = SysAdmin privilege the source requires.
const SUBSYSTEMS = [
  logSource('messages', 'messages.log'),
  logSource('alerts', 'alerts.log'),
  logSource('monitor', 'System Monitor'),
  logSource('journal', 'Journal log'),
  {
    id: 'apperrors', label: 'Application errors',
    load: async () => (await ext.get('/apperrors', { days: 30, limit: 300 })).map((e) => ({
      ts: e.ts, severity: 2, title: `${e.namespace}: ${e.message}`, similar: e.message, detail: `error #${e.number} · pid ${e.pid} · ${e.username}${e.line ? ` · ${e.line}` : ''}`,
    })),
  },
  {
    id: 'audit', label: 'Audit', needs: 'Secure',
    load: async () => {
      let r = await admin.post('/v2/security/audit/records', {}, { maxRows: 300, ascending: 0 });
      if (r && r.GUID && r.State === 'Queued') {
        const task = await waitAsync(r.GUID, { interval: 500, timeoutMs: 20000 });
        // A failed or cancelled query is an unavailable source, not an empty audit log.
        if (!/finish|complete|done/i.test(String(task.State))) throw new Error(`Audit query ${String(task.State).toLowerCase()}`);
        r = task.Result;
      }
      return (Array.isArray(r) ? r : []).map((a) => ({
        ts: String(a.TimeStamp || '').slice(0, 19),
        severity: /LoginFailure/i.test(a.Event) ? 2 : AUDIT_WARN.test(a.Event) ? 1 : 0,
        title: `${a.EventSource}/${a.EventType}/${a.Event} · ${a.Username || '—'}${a.Description ? `: ${a.Description}` : ''}`,
        event: a.Event, user: a.Username,
        detail: a.EventData || '',
      }));
    },
  },
  {
    id: 'tasks', label: 'Task Manager', needs: ['Operate', 'Task'],
    load: async () => {
      // A failed run of a task that still exists can be run again; history outlives deleted tasks.
      const [history, tasks] = await Promise.all([admin.get('/v2/task/history', { maxRows: 300 }), admin.get('/v2/tasks').catch(() => [])]);
      const existing = new Set(tasks.map((t) => String(t.Id)));
      return history.map((t) => {
        const failed = Number(t.ErrNumber) || /error/i.test(t.Result || '');
        return { ts: t.Completed || t.LastStart || t.LogDatetime, severity: failed ? 2 : 0,
          failedTask: failed && existing.has(String(t.TaskId)) ? { id: t.TaskId, name: t.Name } : null,
          title: `${t.Name}: ${t.Result || (failed ? `error ${t.ErrNumber}` : 'completed')}`, detail: `${t.Routine || ''} · pid ${t.Pid || '—'} · ${t.Namespace || ''}` };
      });
    },
  },
];

/**
 * Loads the selected sources in parallel. Each source reports its own status, so a source the user
 * may not read ("no permission") or that failed ("unavailable") is visible instead of silently empty.
 */
async function collectTimeline(active, minSeverity) {
  const results = await Promise.all(SUBSYSTEMS.filter((s) => active.has(s.id)).map(async (s) => {
    if (s.needs && !can(...[s.needs].flat())) return { source: s, status: 'denied', rows: [] };
    try {
      const rows = (await s.load(minSeverity)).filter((x) => x.ts && x.severity >= minSeverity).map((x) => ({ ...x, subsystem: s.label }));
      return { source: s, status: 'live', rows };
    } catch (e) {
      return { source: s, status: e.status === 403 ? 'denied' : 'unavailable', rows: [], error: e.message };
    }
  }));
  const rows = results.flatMap((r) => r.rows).sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { rows, statuses: results.map(({ source, status, rows: r, error }) => ({ label: source.label, status, count: r.length, error })) };
}

function sourceStatus({ label, status, count, error }) {
  if (status === 'live') return badge(`${label}: ${count}`, 'ok');
  return h('span', { title: error || '' }, badge(`${label}: ${status === 'denied' ? 'no permission' : 'unavailable'}`, status === 'denied' ? 'muted' : 'warn'));
}

/**
 * The next step for a timeline event, when its data calls for one: mount a database that is still
 * dismounted, run a failed task again, look for similar incidents of an application error, open a
 * user with a burst of failed logins. `ctx` = { dismounted: Set of dirs, bursts: Map user -> count, onSimilar, refresh }.
 */
function eventSteps(r, ctx) {
  const dir = dismountedIn(r.title);
  return nextSteps(
    dir && ctx.dismounted.has(dir) && can('Operate') && mountStep(dir, ctx.refresh),
    r.failedTask && can('Task') && runAgainStep(r.failedTask.id, r.failedTask.name),
    r.failedTask && can('Operate', 'Task') && openLink('Open task', `tasks/${r.failedTask.id}`),
    r.similar && stepButton('Similar incidents', () => ctx.onSimilar(r.similar), 'Search the indexed logs for entries describing the same problem'),
    ctx.bursts.has(r.user) && /LoginFailure/i.test(r.event) && can('Secure')
      && openLink('Open user', `users/${encodeURIComponent(r.user)}`, `${ctx.bursts.get(r.user)} failed logins in the timeline`));
}

function timeline(box, initialQuery, onSimilar) {
  const active = new Set(SUBSYSTEMS.map((s) => s.id));
  let minSeverity = initialQuery ? 0 : 1;
  const out = h('div');
  const search = h('input', { type: 'search', placeholder: 'Filter text…', value: initialQuery, 'aria-label': 'Filter timeline text' });
  const chips = h('div.chips', SUBSYSTEMS.map((s) => h('button.chip.active', {
    'aria-pressed': 'true',
    onclick: (e) => {
      if (active.has(s.id)) active.delete(s.id); else active.add(s.id);
      e.currentTarget.classList.toggle('active', active.has(s.id));
      e.currentTarget.setAttribute('aria-pressed', String(active.has(s.id)));
      run();
    },
  }, s.label)));
  const sev = h('select', { 'aria-label': 'Minimum severity', onchange: () => { minSeverity = Number(sev.value); run(); } },
    [[0, 'All events'], [1, 'Warnings and errors'], [2, 'Errors only']].map(([v, l]) => h('option', { value: v, selected: v === minSeverity }, l)));
  let rows = [];
  let statuses = [];
  let ctx = { dismounted: new Set(), bursts: new Map(), onSimilar };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const shown = q ? rows.filter((r) => `${r.title} ${r.detail} ${r.subsystem}`.toLowerCase().includes(q)) : rows;
    clear(out,
      h('div.toolbar.small', statuses.map(sourceStatus)),
      h('p.muted.small', `${shown.length} events${q ? ` matching “${search.value.trim()}”` : ''} · newest first`),
      shown.length ? h('div.log-list.table-wrap', shown.slice(0, 500).map((r) => h(`div.log-line.timeline-line.sev-${r.severity}`, { tabindex: 0 },
        h('span.muted', r.ts), severityBadge(r.severity), badge(r.subsystem, 'accent-soft'), h('span.msg', r.title, eventSteps(r, ctx)),
        r.detail && r.detail !== r.title ? h('details.small', h('summary', 'details'), h('pre', r.detail)) : null)))
        : h('div.empty-state', 'No events for these filters.'));
  };
  const run = async () => {
    clear(out, loading('Collecting events from all subsystems…'));
    try {
      // Database state is read only when a log line reports a dismount, to offer Mount while it still applies.
      ({ rows, statuses } = await collectTimeline(active, minSeverity));
      const dismounted = rows.some((r) => dismountedIn(r.title)) && can('Operate')
        ? new Set(await admin.get('/v2/database-dirs').then(dismountedDirs, () => [])) : new Set();
      // "Open user" only for accounts that exist: failed logins with a made-up name have no user record.
      const bursts = loginFailureBursts(rows);
      if (bursts.size) {
        const users = new Set(await admin.get('/v2/security/users').then((list) => list.map((u) => u.Name), () => []));
        for (const name of bursts.keys()) if (!users.has(name)) bursts.delete(name);
      }
      ctx = { dismounted, bursts, onSimilar, refresh: run };
      draw();
    } catch (e) { clear(out, errorBox(e, run)); }
  };
  search.addEventListener('input', draw);
  clear(box,
    h('p.muted', 'messages.log, alerts.log, SystemMonitor.log, journal.log, ^ERRORS of every namespace, the security audit and Task Manager history.'),
    h('div.toolbar', chips), h('div.toolbar', sev, search), out);
  run();
}
