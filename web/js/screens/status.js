// Status: is the instance healthy right now, and how did it behave over the last hour?
// Health and latency come from the server-side sampler (AdminDeck.Metrics: the monitoring metrics IRIS
// publishes, every 5 seconds); errors over time from messages.log and the application error log.
// Checks: one row per known risk (checks.js), with the evidence and a fix.
import { admin, ext } from '../api.js';
import { navigate, can } from '../app.js';
import { h, clear, page, errorBox, loading, sparkline, button, badge } from '../ui.js';
import { statusSummary } from '../status-summary.js';
import { evaluate, tally } from '../checks.js';
import { nextSteps, openLink, mountStep, runAgainStep } from '../actions.js';

const REFRESH_MS = 5000;
const ERRORS_REFRESH_MS = 60000;
const LOG_LIMIT = 2000;
const MINUTES = 60;
const LEVEL = ['ok', 'warn', 'err'];
const STATE = { '-1': 'Hung', 0: 'OK', 1: 'Warning', 2: 'Alert' };

// What each row reads from a sample, and from which value it counts as degraded (warn) or failing (err).
const COMPONENTS = [
  {
    name: 'IRIS instance',
    field: 'systemState',
    level: (v) => (v === 0 ? 0 : v === 1 ? 1 : 2),
    text: (v) => STATE[v] ?? '—',
    hint: 'Overall state reported by IRIS; alerts.log says why it is not OK.',
    link: 'logs/alerts',
  },
  {
    name: 'Web gateway',
    field: 'gatewayLatencyMs',
    warn: 50,
    err: 250,
    unit: 'ms',
    hint: 'Time the Web Gateway takes to answer.',
  },
  {
    name: 'Database reads',
    field: 'dbReadLatencyMs',
    warn: 10,
    err: 50,
    unit: 'ms',
    hint: 'Slowest random read across all databases.',
  },
  {
    name: 'SQL',
    field: 'sqlAvgMs',
    warn: 250,
    err: 1000,
    unit: 'ms',
    hint: 'Average statement runtime, weighted by each namespace’s rate.',
  },
  { name: 'CPU', field: 'cpuPct', warn: 85, err: 95, unit: '%', hint: 'CPU usage of the environment IRIS runs in.' },
];
const CHARTS = [
  ['Web requests / s', 'webRequestsPerSec', 'var(--accent)', 'requests / s'],
  ['Gateway latency (ms)', 'gatewayLatencyMs', 'var(--muted)', 'ms'],
  ['SQL statements / s', 'sqlPerSec', 'var(--accent)', 'statements / s'],
  ['Average SQL runtime (ms)', 'sqlAvgMs', 'var(--muted)', 'ms'],
  ['Slowest database read (ms)', 'dbReadLatencyMs', 'var(--muted)', 'ms'],
  ['Global references / s', 'globalRefsPerSec', 'var(--accent)', 'references / s'],
];

// Per-second rate of a cumulative counter over a sliding window (the Web Gateway counter moves in steps);
// a counter that went down (gateway restart) counts as no traffic.
function rate(times, totals, windowSec) {
  let j = 0;
  return totals.map((v, i) => {
    while (times[i] - times[j] > windowSec) j++;
    const secs = times[i] - times[j];
    if (v === null || totals[j] === null) return null;
    return secs > 0 ? Math.max(0, (v - totals[j]) / secs) : 0;
  });
}

// -1 = unknown (no sample, or IRIS did not publish the value)
const levelOf = (c, v) =>
  v === null || v === undefined ? -1 : c.level ? c.level(v) : v >= c.err ? 2 : v >= c.warn ? 1 : 0;
const known = (values) => values.filter((v) => v !== null);
const fmt = (v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : String(+v.toFixed(v >= 10 ? 1 : 2)));

export default async function render(el) {
  const banner = h('div.status-banner');
  const checks = h('div.card.checks', { id: 'status-checks', tabindex: '-1' });
  let components = [];
  let counts = null;
  let unavailable = '';
  const updateBanner = () => {
    const summary = statusSummary(components, counts, unavailable);
    clear(
      banner,
      h(
        `div.status-banner-inner.${summary.level}`,
        h('span.status-dot'),
        h('strong', summary.text),
        summary.checksAttention
          ? button(
              'View checks',
              () => {
                checks.scrollIntoView({ block: 'start' });
                checks.focus({ preventScroll: true });
              },
              'small',
            )
          : null,
      ),
    );
  };
  const updateChecks = (value) => {
    counts = value;
    updateBanner();
  };
  const rows = h('div.card');
  const charts = h('div.grid.wide');
  const errors = h('div.card');
  el.append(
    page(
      'Status',
      'Sampled every 5 s by AdminDeck.Metrics on the server; the last hour is kept.',
      banner,
      checks,
      h('div', { style: { marginTop: '14px' } }, rows),
      h('div', { style: { marginTop: '14px' } }, charts),
      h('div', { style: { marginTop: '14px' } }, errors),
    ),
  );
  clear(rows, loading());
  const refreshErrors = async () => {
    if (!el.isConnected) return;
    await renderErrors(errors);
    setTimeout(refreshErrors, ERRORS_REFRESH_MS);
  };
  refreshErrors();
  const refreshChecks = async () => {
    if (!el.isConnected) return;
    await renderChecks(checks, updateChecks);
    setTimeout(refreshChecks, ERRORS_REFRESH_MS);
  };
  refreshChecks();

  const tick = async () => {
    if (!el.isConnected) return;
    try {
      const hist = await ext.get('/metrics');
      const series = Object.fromEntries(hist.fields.map((f, i) => [f, hist.points.map((p) => p[i + 1])]));
      series.webRequestsPerSec = rate(
        hist.points.map((p) => p[0]),
        series.webRequests,
        120,
      );
      const age = hist.points.length ? hist.now - hist.points.at(-1)[0] : 0;
      components = COMPONENTS.map((c) => ({ name: c.name, level: levelOf(c, series[c.field].at(-1)) }));
      unavailable =
        age > 3 * hist.interval ? `No new samples for ${Math.round(age)} s. The values below are stale.` : '';
      updateBanner();
      renderRows(
        rows,
        hist.now,
        hist.points.map((p) => p[0]),
        series,
      );
      renderCharts(
        charts,
        series,
        hist.points.map((p) => p[0]),
      );
    } catch (e) {
      unavailable = 'Status unavailable: the metrics could not be read.';
      updateBanner();
      clear(rows, errorBox(e));
    }
    setTimeout(tick, REFRESH_MS);
  };
  tick();
}

function renderRows(box, now, times, series) {
  clear(
    box,
    h('h2', 'Components', h('span.muted.small', `last ${MINUTES} min · one bar per minute`)),
    COMPONENTS.map((c) => {
      const values = series[c.field];
      const last = values.at(-1);
      const show = (v) => (c.text ? c.text(v) : `${fmt(v)} ${c.unit}`);
      // Worst level per minute (and the value that caused it), oldest minute first; minutes without samples stay empty.
      const minutes = Array.from({ length: MINUTES }, () => ({ level: -1, value: null }));
      values.forEach((v, i) => {
        const m = MINUTES - 1 - Math.floor((now - times[i]) / 60);
        const level = levelOf(c, v);
        if (m < 0 || m >= MINUTES || level < 0) return;
        if (level > minutes[m].level || (level === minutes[m].level && !c.text && v > minutes[m].value))
          Object.assign(minutes[m], { level, value: v });
      });
      const seen = known(values);
      const okShare = seen.length
        ? Math.round((100 * seen.filter((v) => levelOf(c, v) === 0).length) / seen.length)
        : null;
      const current = levelOf(c, last);
      return h(
        'div.status-row',
        { title: c.hint },
        h(
          'div.status-name',
          h(`span.status-dot.${current < 0 ? 'none' : LEVEL[current]}`),
          c.link ? h('a', { href: `#/${c.link}` }, c.name) : h('span', c.name),
        ),
        h('div.status-value', current < 0 ? '—' : show(last)),
        h(
          'div.status-bars',
          minutes.map((m, i) =>
            h(`span.bar.${m.level < 0 ? 'none' : LEVEL[m.level]}`, {
              title:
                m.level < 0
                  ? `${MINUTES - i} min ago · no data`
                  : `${MINUTES - i} min ago · ${c.text ? '' : 'worst '}${show(m.value)}`,
            }),
          ),
        ),
        h('div.status-uptime.muted.small', okShare === null ? '' : `${okShare}% normal`),
      );
    }),
    h(
      'p.muted.small',
      'Thresholds: web gateway 50 / 250 ms, database read 10 / 50 ms, SQL 250 / 1000 ms, CPU 85 / 95 % (warning / failing).',
    ),
  );
}

function renderCharts(box, series, times) {
  clear(
    box,
    CHARTS.map(([title, field, color, label]) => {
      const values = known(series[field]);
      const max = values.length ? Math.max(...values) : 0;
      const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
      return h(
        'div.card',
        h('h2', title, h('span.muted.small', values.length ? `avg ${fmt(avg)} · max ${fmt(max)}` : 'no data yet')),
        sparkline(series[field], color, { slots: 720, format: fmt, times, label }),
        field === 'webRequestsPerSec'
          ? h('p.muted.small', 'Averaged over 2 minutes. IRIS counts web requests per gateway, not per application.')
          : null,
      );
    }),
  );
}

// Warnings and errors per hour over the last 24 hours (instance clock), stacked; a bar opens the timeline.
async function renderErrors(box) {
  if (!box.childElementCount) clear(box, h('h2', 'Warnings and errors per hour'), loading());
  try {
    const [log, app, hist] = await Promise.all([
      ext.get('/logs/messages', { severity: 1, limit: LOG_LIMIT }),
      ext.get('/apperrors', { days: 2, limit: 500 }).catch(() => null),
      ext.get('/metrics'),
    ]);
    const hourOf = (ts) => String(ts).slice(0, 13); // "YYYY-MM-DD HH"
    const end = new Date(`${hist.serverTime.replace(' ', 'T')}Z`);
    const hours = Array.from({ length: 24 }, (_, i) =>
      new Date(end - (23 - i) * 3600e3).toISOString().slice(0, 13).replace('T', ' '),
    );
    const counts = Object.fromEntries(hours.map((k) => [k, { warn: 0, err: 0 }]));
    for (const e of log.entries || [])
      if (counts[hourOf(e.ts)]) counts[hourOf(e.ts)][e.severity >= 2 ? 'err' : 'warn']++;
    for (const e of app || []) if (counts[hourOf(e.ts)]) counts[hourOf(e.ts)].err++;
    // Only the newest LOG_LIMIT entries are read: when the limit is hit, hours before the oldest one are incomplete.
    const entries = log.entries || [];
    const partialBefore =
      entries.length >= LOG_LIMIT ? hourOf(entries.reduce((a, e) => (e.ts < a ? e.ts : a), entries[0].ts)) : null;
    const top = Math.max(1, ...hours.map((k) => counts[k].warn + counts[k].err));
    const total = hours.reduce((n, k) => n + counts[k].warn + counts[k].err, 0);
    clear(
      box,
      h(
        'h2',
        'Warnings and errors per hour',
        h('span.muted.small', `last 24 h · ${total} in messages.log${app ? ' and application errors' : ''}`),
      ),
      app ? null : h('p.muted.small', 'Application errors are not included: they could not be read.'),
      partialBefore
        ? h(
            'p.muted.small',
            `Busy log: counts before ${partialBefore.slice(11)}:00 are incomplete (newest ${LOG_LIMIT} entries only).`,
          )
        : null,
      h(
        'div.hour-bars',
        hours.map((k) => {
          const c = counts[k];
          return h(
            'button.hour',
            {
              title: `${k}:00: ${c.err} errors, ${c.warn} warnings`,
              'aria-label': `${k}:00: ${c.err} errors, ${c.warn} warnings`,
              onclick: () => navigate('logs'),
            },
            h(
              'span.stack',
              h('span.seg.err', { style: { height: `${(100 * c.err) / top}%` } }),
              h('span.seg.warn', { style: { height: `${(100 * c.warn) / top}%` } }),
            ),
            h('span.hour-label', k.slice(11)),
          );
        }),
      ),
      h(
        'div.toolbar.small',
        { style: { marginTop: '8px' } },
        h('span.legend.err', 'errors'),
        h('span.legend.warn', 'warnings'),
        button('Open timeline', () => navigate('logs'), 'small'),
      ),
    );
  } catch (e) {
    clear(box, h('h2', 'Warnings and errors per hour'), errorBox(e));
  }
}

// ---------- checks ----------
const CHECK_LEVEL = { fail: 'err', warn: 'warn', ok: 'ok', unknown: 'none' };
const CHECK_LABEL = { fail: 'failing', warn: 'warning', ok: 'ok', unknown: 'not checked' };

// Reads one source for the checks: { unavailable: reason } without the privilege or when the call fails.
function source(privs, read) {
  if (privs && !can(...privs)) return Promise.resolve({ unavailable: `Needs the ${privs.join(' or ')} privilege.` });
  // A missing SQL privilege comes back as a 500 with "not privileged" in the text (backups): it is still a permission.
  return read().catch((e) => ({
    unavailable:
      e && (e.status === 401 || e.status === 403 || /not privileged/i.test(e.message || ''))
        ? 'Your user may not read this.'
        : `The source is unavailable (${(e && e.message) || e}).`,
  }));
}

// Databases: the file list joined with the definitions (names), plus journaling from each database-dir.
async function readDatabases() {
  const [dirs, defs] = await Promise.all([admin.get('/v2/database-dirs'), admin.get('/v2/databases').catch(() => [])]);
  const rows = (Array.isArray(dirs) ? dirs : []).map((r) => ({
    ...r,
    Name: (defs.find((d) => d.Directory === r.Directory) || {}).Name,
  }));
  await Promise.all(
    rows.map((r) =>
      admin.get('/v2/database-dir', { dir: r.Directory }).then(
        (d) => {
          r.GlobalJournalState = !!d.GlobalJournalState;
          if (d.ReadOnly) r.ReadOnly = true;
        },
        () => {},
      ),
    ),
  );
  return rows;
}

async function readCertificates() {
  const creds = await admin.get('/v2/security/x509-credentials');
  return Promise.all(
    creds.map((c) =>
      admin.get('/v2/security/x509-credential/certificate', { alias: c.Alias }).then(
        (cert) => ({ alias: c.Alias, date: cert.ValidityNotAfter }),
        () => ({ alias: c.Alias, date: null }),
      ),
    ),
  );
}

async function renderChecks(box, onSummary) {
  const refresh = () => renderChecks(box, onSummary);
  if (!box.childElementCount) clear(box, h('h2', 'Checks'), loading());
  const dashboard = source(['Operate'], () => admin.get('/v2/monitor/dashboard/main'));
  const part = (key) => dashboard.then((m) => (m.unavailable ? m : key(m)));
  const [
    databases,
    certificates,
    backups,
    tasks,
    taskHistory,
    taskManager,
    licensing,
    journalSpace,
    disks,
    metrics,
    audit,
  ] = await Promise.all([
    source(['Manage', 'Operate'], readDatabases),
    source(['Secure'], readCertificates),
    source(['Operate'], () => ext.get('/backups', { limit: 50 })),
    source(['Operate', 'Task'], () => admin.get('/v2/tasks')),
    source(['Operate', 'Task'], () => admin.get('/v2/task/history', { maxRows: 300 })),
    source(['Operate', 'Task'], () => admin.get('/v2/task/manager')),
    part((m) => m.Licensing || { unavailable: 'IRIS reports no license data.' }),
    part((m) => (m.SystemUsage || {}).JournalSpace || ''),
    source(['Operate'], () => ext.get('/os').then((os) => os.disks || [])),
    // The first read starts a stopped sampler: without samples, read again after one interval.
    source(['Operate'], () =>
      ext
        .get('/metrics')
        .then((m) =>
          m.points.length
            ? m
            : new Promise((r) => setTimeout(r, (m.interval + 1) * 1000)).then(() => ext.get('/metrics')),
        ),
    ),
    source(['Secure'], () => admin.get('/v2/security/audit/enabled')),
  ]);
  let rows;
  try {
    rows = evaluate({
      databases,
      certificates,
      backups,
      tasks,
      taskHistory,
      taskManager,
      licensing,
      journalSpace,
      disks,
      metrics,
      audit,
    });
  } catch (e) {
    clear(box, h('h2', 'Checks'), errorBox(e));
    onSummary(null);
    return;
  }
  const n = tally(rows);
  onSummary(n);
  clear(
    box,
    h(
      'h2',
      'Checks',
      h(
        'span.muted.small',
        [
          n.fail && `${n.fail} failing`,
          n.warn && `${n.warn} warnings`,
          n.unknown && `${n.unknown} not checked`,
          `${n.ok} ok`,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
    rows.map((r) =>
      h(
        `div.check-row.${r.state}`,
        { 'data-check': r.id },
        h('div.check-name', h(`span.status-dot.${CHECK_LEVEL[r.state]}`), h('strong', r.title)),
        h(
          'div.check-state',
          badge(CHECK_LABEL[r.state], CHECK_LEVEL[r.state] === 'none' ? 'muted' : CHECK_LEVEL[r.state]),
        ),
        h(
          'div.check-body',
          h('div', r.evidence),
          r.state === 'ok' ? null : h('div.muted.small', r.advice, nextSteps(r.steps.map((s) => step(s, refresh)))),
        ),
      ),
    ),
    h(
      'p.muted.small',
      'Read once a minute from data this app already shows. A check is not run when your user may not read its source.',
    ),
  );
}

// A step descriptor of checks.js as a link or button of actions.js; writes only with the privilege.
function step(s, refresh) {
  if (s.kind === 'mount') return can('Operate') ? mountStep(s.dir, refresh) : null;
  if (s.kind === 'run') return can('Task') ? runAgainStep(s.id, s.name) : null;
  return openLink(s.label, s.hash);
}
