// Dashboard: health at a glance, live throughput, resources and what needs attention.
import { admin, ext } from '../api.js';
import { navigate, can } from '../app.js';
import { h, clear, page, meter, badge, fmtBytes, fmtDuration, severityBadge, errorBox, loading, sparkline } from '../ui.js';
import { dismountedDirs, nextSteps, openLink, mountStep, backupFinding, BACKUP_MAX_AGE_DAYS } from '../actions.js';

const REFRESH_MS = 5000;
const HISTORY = 360; // last 30 minutes of the server-side sampler (AdminDeck.Metrics, 5-second samples)

export default async function render(el) {
  let series = { grefs: [], cpu: [] };
  const summary = h('p.dash-summary.muted.small');
  const healthCard = h('div.card');
  const resCard = h('div.card');
  const liveCard = h('div.card');
  const attnCard = h('div.card');
  const tasksCard = h('div.card');
  el.append(page('Dashboard', null,
    h('div.grid.wide', liveCard, resCard, healthCard, attnCard, tasksCard),
    summary));
  clear(liveCard, loading());

  let first = true;
  const tick = async () => {
    if (!el.isConnected) return;
    {
      const [main, os, hist] = await Promise.allSettled([admin.get('/v2/monitor/dashboard/main'), ext.get('/os'), ext.get('/metrics')]);
      // History comes from the server, so the charts are full on arrival; without it they fill while the page is open.
      const recent = hist.status === 'fulfilled' && hist.value.points.length
        && Date.now() / 1000 - hist.value.points[hist.value.points.length - 1][0] < 3 * hist.value.interval;
      if (recent) {
        const points = hist.value.points.slice(-HISTORY);
        series = { grefs: points.map((p) => p[1]), cpu: points.map((p) => p[2]), times: points.map((p) => p[0]) };
      } else series.times = undefined;
      if (main.status === 'fulfilled') {
        const m = main.value;
        if (!recent) push(series.grefs, m.Performance && m.Performance.GlobalRefsPerSecond);
        renderSummary(summary, m);
        renderHealth(healthCard, m);
        renderTasks(tasksCard, m.UpcomingTasks || []);
      } else if (first) {
        clear(liveCard, errorBox(main.reason));
      }
      if (os.status === 'fulfilled') {
        if (!recent) push(series.cpu, os.value.cpu && os.value.cpu.usagePct);
        renderResources(resCard, os.value, (main.status === 'fulfilled' && main.value.Licensing) || {});
      } else if (first) {
        clear(resCard, h('h2', 'Resources'), h('p.muted', `OS metrics unavailable: ${os.reason.message}`));
      }
      renderLive(liveCard, series);
      if (first) renderAttention(attnCard, main.status === 'fulfilled' ? main.value.Alerts || {} : {});
      first = false;
    }
    setTimeout(tick, REFRESH_MS);
  };
  tick();
}

function push(arr, v) {
  if (typeof v !== 'number') return;
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
}

// One quiet line at the bottom: how long the instance runs and how much is running.
function renderSummary(box, m) {
  const su = m.SystemUsage || {};
  clear(box, `IRIS up ${shortUptime(m.Status && m.Status.UpTime)} · last backup: ${(m.Status && m.Status.LastBackup) || 'never'} · `,
    h('a', { href: '#/processes' }, `${num(su.Processes)} processes`), ` · ${num(su.CSPSessions)} web sessions`);
}

// "0d 0h 31m" -> "31m", "2d 4h 5m" -> "2d 4h 5m"
const shortUptime = (s) => (s || '—').replace(/\s+/g, ' ').replace(/^(0[dh] )+/, '');

function num(v) { return typeof v === 'number' ? v.toLocaleString('en-US') : (v ?? '—'); }

const OK_WORDS = new Set(['Normal', 'OK', 'Ok', 'Running']);
function renderHealth(box, m) {
  const su = m.SystemUsage || {};
  const ecp = m.ECP || {};
  const checks = [
    ['Database space', su.DatabaseSpace], ['Database journal', su.DatabaseJournal], ['Journal space', su.JournalSpace],
    ['Lock table', su.LockTable], ['Write daemon', su.WriteDaemon], ['ECP clients', ecp.ECPClients], ['ECP servers', ecp.ECPServers],
    ['Mirroring / shadows', ecp.Shadows], ['System Monitor', m.Status && (m.Status.SystemMonitor ? 'Running' : 'Stopped')],
  ].filter(([, v]) => v !== undefined && v !== ''); // right after startup IRIS reports some checks as empty
  const bad = checks.filter(([, v]) => !OK_WORDS.has(v) && v !== 'Stopped');
  clear(box,
    h('h2', 'Health checks', bad.length ? badge(`${bad.length} to review`, 'warn') : badge('All normal', 'ok')),
    h('dl.kv', checks.map(([k, v]) => [h('dt', k), h('dd', badge(v, OK_WORDS.has(v) ? 'ok' : v === 'Stopped' ? 'muted' : 'warn'))])));
}

function renderResources(box, os, lic) {
  const mem = os.memory || {};
  // Install, manager and journal directories usually share one filesystem: then it is just "Disk".
  const disks = (os.disks || []).filter((d) => !d.sameFilesystemAs);
  // LicenseUse is a percentage of LicenseLimit (license units), "" when there is no limit.
  const licPct = Number(lic.LicenseUse) || 0;
  clear(box,
    h('h2', 'Resources', os.hostname ? h('span.muted.small', `${os.hostname} · up ${fmtDuration(os.uptimeSec)}`) : null),
    row('CPU', `${os.cpu.usagePct}% · ${os.cpu.cores} cores`, os.cpu.usagePct),
    row('Memory', `${fmtBytes(mem.used)} of ${fmtBytes(mem.total)}${mem.containerLimit ? ` (limit ${fmtBytes(mem.containerLimit)})` : ''}`, mem.usedPct),
    disks.map((d) => row(disks.length > 1 ? `Disk · ${d.label}` : 'Disk', `${fmtBytes(d.free)} free of ${fmtBytes(d.total)}`, d.usedPct, d.path)),
    lic.LicenseLimit && lic.LicenseUse !== '' ? row('License units', `${licPct}% of ${lic.LicenseLimit}`, licPct,
      'Concurrent users/connections the license allows; new ones are refused when it is full') : null);
}

function row(label, text, pct, title) {
  return h('div', { style: { margin: '10px 0' }, title },
    h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px' } }, h('strong', label), h('span.muted.small', text)),
    meter(pct, label));
}

function renderLive(box, series) {
  clear(box,
    h('h2', 'Live throughput', h('span.muted.small', `last ${HISTORY * REFRESH_MS / 60000} min · `,
      h('a', { href: '#/status' }, 'Last hour →'))),
    h('div.small.muted', 'Global references per second'),
    sparkline(series.grefs, 'var(--accent)', { slots: HISTORY, times: series.times, label: 'references / s' }),
    h('div.small.muted', { style: { marginTop: '10px' } }, 'CPU %'),
    sparkline(series.cpu, 'var(--muted)', { max: 100, slots: HISTORY, times: series.times, label: '% CPU' }));
}

// What an administrator should look at: dismounted databases, certificates about to expire, then
// recurring log problems — each with its next step at the end of the line.
async function renderAttention(box, alerts) {
  clear(box, h('h2', 'Needs attention'), loading());
  const [insights, certificates, dirs, backups] = await Promise.all([
    ext.get('/logs/messages/insights', { severity: 1, top: 6 }).catch((e) => e),
    can('Secure') ? expiringCertificates().catch(() => []) : [],
    admin.get('/v2/database-dirs').then(dismountedDirs, () => []),
    // Unreadable backup history: say nothing rather than guess (the Backups tab shows the error).
    ext.get('/backups', { limit: 50 }).then(backupFinding, () => null),
  ]);
  const serious = (alerts.SeriousAlerts || 0) + (alerts.ApplicationErrors || 0);
  const pats = insights instanceof Error ? [] : insights.patterns || [];
  // One list, most severe first: errors, then an expired or expiring certificate, then warnings.
  const items = [
    ...dirs.map((dir) => ({ level: 2, el: h('li.attention-item',
      badge('dismounted', 'err'), ' ', `Database ${dir} is dismounted`,
      nextSteps(can('Operate') && mountStep(dir, () => renderAttention(box, alerts)))) })),
    ...certificates.map((c) => ({ level: c.days < 0 ? 2 : 1, el: h('li.attention-item',
      badge(c.days < 0 ? 'expired' : `${c.days} d`, c.days < 0 ? 'err' : 'warn'), ' ',
      `X.509 credential ${c.alias}`, c.days < 0 ? ' has expired' : ` expires ${c.date}`,
      nextSteps(openLink('Open credential', `secrets/x509/${encodeURIComponent(c.alias)}`))) })),
    ...(backups ? [{ level: backups.lastFailed ? 2 : 1, el: backupItem(backups) }] : []),
    ...pats.map((p) => ({ level: Math.min(p.maxSeverity, 2), el: h('li.attention-item',
      severityBadge(p.maxSeverity), ' ', h('strong', `${p.count}×`), ' ', h('span', p.example),
      h('div.muted.small', `${p.source} · last ${p.last}`)) })),
  ].sort((a, b) => b.level - a.level);
  clear(box,
    h('h2', 'Needs attention', h('button.small', { onclick: () => navigate('logs') }, 'Open logs')),
    serious ? h('p.muted.small', `${alerts.SeriousAlerts || 0} serious alerts and ${alerts.ApplicationErrors || 0} application errors since startup.`) : null,
    insights instanceof Error ? h('p.muted', `Log insights unavailable: ${insights.message}`) : null,
    items.length ? h('ul.plain', items.map((i) => i.el)) : insights instanceof Error ? null : h('div.empty-state', 'Nothing needs attention right now.'));
}

// Backups: none recorded, the newest successful one older than BACKUP_MAX_AGE_DAYS, or the newest run failed.
function backupItem(f) {
  const text = f.never ? 'No backup has run on this instance'
    : f.days === null ? 'The age of the last successful backup is unknown'
    : f.days > BACKUP_MAX_AGE_DAYS ? `Last successful backup ${f.days} days ago (${f.type}, ${f.time})`
    : `Last successful backup ${f.days === 0 ? 'today' : `${f.days} d ago`} (${f.type})`;
  return h('li.attention-item',
    badge(f.lastFailed ? 'backup failed' : f.never ? 'no backup' : `${f.days} d`, f.lastFailed ? 'err' : 'warn'), ' ', text,
    f.lastFailed ? h('div.muted.small', `Newest run: ${f.lastFailed.type} at ${f.lastFailed.time} — ${f.lastFailed.status || 'no status'}`) : null,
    nextSteps(openLink('Backups', 'system/backups', 'Backup history and how to schedule a backup')));
}

// X.509 credentials whose certificate expires within 30 days (or has expired), soonest first.
async function expiringCertificates() {
  const creds = await admin.get('/v2/security/x509-credentials');
  const certs = await Promise.all(creds.map((c) => admin.get('/v2/security/x509-credential/certificate', { alias: c.Alias })
    .then((cert) => ({ alias: c.Alias, date: cert.ValidityNotAfter }), () => null)));
  return certs.filter((c) => c && Number.isFinite(Date.parse(c.date)))
    .map((c) => ({ ...c, days: Math.floor((Date.parse(c.date) - Date.now()) / 86400000) }))
    .filter((c) => c.days < 30).sort((a, b) => a.days - b.days);
}

function renderTasks(box, rows) {
  clear(box,
    h('h2', 'Upcoming tasks', h('button.small', { onclick: () => navigate('tasks') }, 'All tasks')),
    rows.length ? h('dl.kv', rows.map((t) => [h('dt', t.Time), h('dd', t.Task, ' ', badge(t.Status, t.Status === 'Scheduled' ? 'ok' : 'warn'))]))
      : h('div.empty-state', 'Nothing scheduled.'));
}
