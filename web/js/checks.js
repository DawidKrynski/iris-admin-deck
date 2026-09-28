// Health checks for the Status screen, computed from data the app already reads. Pure: plain objects in,
// check rows out (tested in tests/js/checks.test.mjs); the screen fetches, renders and gates the fixes.
//
// A row: { id, title, state, evidence, advice, steps }
//   state    'fail' | 'warn' | 'ok' | 'unknown' (not checked: no privilege or the source is unavailable)
//   evidence the concrete object and number; for 'unknown' the reason it was not checked
//   steps    [{ kind: 'mount', dir, name } | { kind: 'run', id, name } | { kind: 'link', label, hash }]
// An input the screen could not read is passed as { unavailable: 'reason' }.
import { backupFinding, dismountedDirs, BACKUP_MAX_AGE_DAYS } from './actions.js';
import { READ_ONLY_BY_DEFAULT, licenseUnits } from './iris.js';
import { fmtBytes } from './ui.js';

export const CERT_WARN_DAYS = 30;
export const SIZE_WARN_PCT = 90;
export const SIZE_FAIL_PCT = 98;
export const LICENSE_WARN_PCT = 80;
export const LICENSE_FAIL_PCT = 95;
export const DISK_WARN_PCT = 85;
export const DISK_FAIL_PCT = 95;
// Databases that are not journaled by design.
export const UNJOURNALED_BY_DESIGN = new Set(['IRISTEMP', 'IRISLOCALDATA']);

const ORDER = { fail: 0, warn: 1, unknown: 2, ok: 3 };
const DAY_MS = 86400000;

/** Reason an input was not read, or null when it is usable. */
function missing(x) {
  if (x === null || x === undefined) return 'Not read';
  return typeof x === 'object' && !Array.isArray(x) && x.unavailable ? String(x.unavailable) : null;
}
const row = (id, title, state, evidence, advice, steps = []) => ({ id, title, state, evidence, advice, steps });
const notChecked = (id, title, reason) =>
  row(id, title, 'unknown', reason, 'Check it on its own screen, or sign in with a user who may read it.');
/** "a, b, c and 2 more" */
const list = (items, max = 3) =>
  items.length > max ? `${items.slice(0, max).join(', ')} and ${items.length - max} more` : items.join(', ');
const pct = (v) => `${Math.round(v)} %`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const nameOf = (db) =>
  db.Name ||
  String(db.Directory || '')
    .split('/')
    .filter(Boolean)
    .at(-1) ||
  db.Directory;
const isReadOnly = (db) =>
  db.ReadOnly === true ||
  /\/R$/.test(String(db.Status || '')) ||
  READ_ONLY_BY_DEFAULT.has(String(nameOf(db)).toUpperCase());
const dbLink = { kind: 'link', label: 'Databases', hash: 'system/databases' };

// ---------- the checks ----------

/** Databases: rows of /v2/database-dirs joined with /v2/databases (Name) by directory. */
export function dismountedCheck(databases) {
  const title = 'Databases mounted';
  if (missing(databases)) return notChecked('dismounted', title, missing(databases));
  const dirs = dismountedDirs(databases);
  if (!dirs.length)
    return row('dismounted', title, 'ok', `All ${plural(databases.length, 'database')} are mounted.`, 'Nothing to do.');
  const dbs = dirs.map((dir) => databases.find((d) => d.Directory === dir));
  return row(
    'dismounted',
    title,
    'fail',
    `Dismounted: ${list(dbs.map((d) => `${nameOf(d)} (${d.Directory})`))}.`,
    'Mount the database so applications and tasks can use it again.',
    dbs.map((d) => ({ kind: 'mount', dir: d.Directory, name: nameOf(d) })),
  );
}

/** Journaling: GlobalJournalState of each /v2/database-dir (undefined where it could not be read). */
export function journalingCheck(databases) {
  const title = 'Database journaling';
  if (missing(databases)) return notChecked('journaling', title, missing(databases));
  const relevant = databases.filter(
    (d) => !isReadOnly(d) && !UNJOURNALED_BY_DESIGN.has(String(nameOf(d)).toUpperCase()),
  );
  const read = relevant.filter((d) => typeof d.GlobalJournalState === 'boolean');
  if (!read.length)
    return notChecked(
      'journaling',
      title,
      relevant.length ? 'The journal settings of the databases could not be read.' : 'No database to check.',
    );
  const unread = relevant.length - read.length;
  const note = unread ? ` ${unread} could not be read.` : '';
  const off = read.filter((d) => !d.GlobalJournalState).map(nameOf);
  if (!off.length)
    return row(
      'journaling',
      title,
      'ok',
      `Journaling is on for ${read.length === 1 ? 'the one writable database' : `all ${read.length} writable databases`} (IRISTEMP and IRISLOCALDATA not counted).${note}`,
      'Nothing to do.',
    );
  return row(
    'journaling',
    title,
    'warn',
    `Journaling is off for ${list(off)}.${note}`,
    'Turn on Journal globals for these databases, or you cannot recover their changes after a crash.',
    [dbLink],
  );
}

/** Size limit: Size and MaxSize (MB) of /v2/database-dirs; MaxSize "Unlimited" or 0 means no limit. */
export function maxSizeCheck(databases) {
  const title = 'Database size limits';
  if (missing(databases)) return notChecked('maxsize', title, missing(databases));
  const limited = databases
    .filter((d) => Number(d.MaxSize) > 0 && Number.isFinite(Number(d.Size)))
    .map((d) => ({
      name: nameOf(d),
      size: Number(d.Size),
      max: Number(d.MaxSize),
      pct: (100 * Number(d.Size)) / Number(d.MaxSize),
    }))
    .sort((a, b) => b.pct - a.pct);
  if (!limited.length) return row('maxsize', title, 'ok', 'No database has a maximum size.', 'Nothing to do.');
  const top = limited[0];
  const near = limited.filter((d) => d.pct >= SIZE_WARN_PCT);
  if (!near.length)
    return row(
      'maxsize',
      title,
      'ok',
      `Fullest: ${top.name} at ${top.size} of ${top.max} MB (${pct(top.pct)}).`,
      'Nothing to do.',
    );
  return row(
    'maxsize',
    title,
    top.pct >= SIZE_FAIL_PCT ? 'fail' : 'warn',
    `Near the limit: ${list(near.map((d) => `${d.name} ${d.size} of ${d.max} MB (${pct(d.pct)})`))}.`,
    'Raise the maximum size or free space in the database before writes start to fail.',
    [dbLink],
  );
}

/** Certificates: [{alias, date}] with the certificate's ValidityNotAfter (null when it could not be read). */
export function certificatesCheck(certificates, now = Date.now()) {
  const title = 'Certificates';
  if (missing(certificates)) return notChecked('certificates', title, missing(certificates));
  const dated = certificates
    .filter((c) => Number.isFinite(Date.parse(c.date)))
    .map((c) => ({ ...c, days: Math.floor((Date.parse(c.date) - now) / DAY_MS) }))
    .sort((a, b) => a.days - b.days);
  if (!dated.length)
    return certificates.length
      ? notChecked('certificates', title, 'The certificates could not be read.')
      : row('certificates', title, 'ok', 'No X.509 credentials are stored.', 'Nothing to do.');
  const soon = dated.filter((c) => c.days < CERT_WARN_DAYS);
  if (!soon.length)
    return row(
      'certificates',
      title,
      'ok',
      `${plural(dated.length, 'certificate')}; the next one expires in ${dated[0].days} days (${dated[0].alias}).`,
      'Nothing to do.',
    );
  const text = (c) =>
    c.days < 0 ? `${c.alias} expired on ${c.date}` : `${c.alias} expires in ${c.days} days (${c.date})`;
  return row(
    'certificates',
    title,
    soon[0].days < 0 ? 'fail' : 'warn',
    `${list(soon.map(text))}.`,
    'Renew the certificate and replace it in the credential before clients start to refuse it.',
    soon
      .slice(0, 3)
      .map((c) => ({ kind: 'link', label: `Open ${c.alias}`, hash: `secrets/x509/${encodeURIComponent(c.alias)}` })),
  );
}

/** Backups: GET /admindeck/api/backups, judged by backupFinding (actions.js). */
export function backupCheck(summary) {
  const title = 'Backups';
  if (missing(summary)) return notChecked('backup', title, missing(summary));
  const link = [{ kind: 'link', label: 'Backups', hash: 'system/backups' }];
  const f = backupFinding(summary);
  if (!f) {
    const ages = Object.values(summary.lastSuccessful || {})
      .concat(summary.history || [])
      .filter((r) => r && r.ok && typeof r.ageDays === 'number')
      .map((r) => r.ageDays);
    return row(
      'backup',
      title,
      'ok',
      ages.length ? `Last successful backup ${Math.min(...ages)} days ago.` : 'A successful backup is recorded.',
      'Nothing to do.',
    );
  }
  const failed = f.lastFailed
    ? ` The newest run (${f.lastFailed.type}, ${f.lastFailed.time}) did not succeed: ${f.lastFailed.status || 'no status'}.`
    : '';
  const text = f.never
    ? 'No successful backup is recorded.'
    : f.days === null
      ? 'The age of the last successful backup is unknown.'
      : `Last successful backup ${f.days} days ago (${f.type}, ${f.time}).`;
  return row(
    'backup',
    title,
    f.lastFailed ? 'fail' : 'warn',
    text + failed,
    f.lastFailed
      ? 'Find out why the last backup failed and run it again.'
      : `Schedule a backup that runs at least every ${BACKUP_MAX_AGE_DAYS} days.`,
    link,
  );
}

/** Failed task runs: /v2/tasks and /v2/task/history (newest first); the newest entry of each task counts. */
export function taskRunsCheck(tasks, history) {
  const title = 'Last task runs';
  const reason = missing(tasks) || missing(history);
  if (reason) return notChecked('taskruns', title, reason);
  const newest = new Map();
  for (const r of history) if (!newest.has(String(r.TaskId))) newest.set(String(r.TaskId), r);
  const failed = tasks
    .map((t) => ({ task: t, run: newest.get(String(t.Id)) }))
    .filter(({ run }) => run && (Number(run.ErrNumber) || /error/i.test(run.Result || '')));
  const seen = tasks.filter((t) => newest.has(String(t.Id))).length;
  if (!failed.length)
    return row(
      'taskruns',
      title,
      'ok',
      `The last recorded run of each of ${plural(seen, 'task')} succeeded.`,
      'Nothing to do.',
    );
  const text = ({ task, run }) =>
    `${task.Name} (#${task.Id}) at ${run.Completed || run.LastStart || run.LogDatetime}: ${run.Result || `error ${run.ErrNumber}`}`;
  return row(
    'taskruns',
    title,
    'fail',
    `Last run failed: ${list(failed.map(text), 2)}.`,
    'Read the error, fix its cause, then run the task again.',
    failed.slice(0, 3).flatMap(({ task }) => [
      { kind: 'run', id: task.Id, name: task.Name },
      { kind: 'link', label: `Open ${task.Name}`, hash: `tasks/${task.Id}` },
    ]),
  );
}

/** Suspended tasks: /v2/tasks (Suspended) and /v2/task/manager (Status). */
export function suspendedCheck(tasks, manager) {
  const title = 'Task Manager';
  if (missing(tasks) && missing(manager)) return notChecked('suspended', title, missing(tasks));
  const link = [{ kind: 'link', label: 'Tasks', hash: 'tasks' }];
  const managerStatus = missing(manager) ? null : String(manager.Status || '');
  if (managerStatus && managerStatus !== 'Running') {
    return row(
      'suspended',
      title,
      'fail',
      `The Task Manager is ${managerStatus}: no scheduled task runs.`,
      'Resume the Task Manager on the Tasks screen.',
      link,
    );
  }
  if (missing(tasks))
    return row('suspended', title, 'ok', `The Task Manager is running. Tasks: ${missing(tasks)}.`, 'Nothing to do.');
  const suspended = tasks.filter((t) => t.Suspended);
  const state = managerStatus ? 'The Task Manager is running' : 'The Task Manager state could not be read';
  if (!suspended.length)
    return row(
      'suspended',
      title,
      'ok',
      `${state}; none of ${plural(tasks.length, 'task')} is suspended.`,
      'Nothing to do.',
    );
  return row(
    'suspended',
    title,
    'warn',
    `${state}; suspended: ${list(suspended.map((t) => `${t.Name} (#${t.Id})`))}.`,
    'Resume the tasks that should run, or delete the ones nobody needs.',
    link,
  );
}

/** License: Licensing of /v2/monitor/dashboard/main (LicenseUse is a percentage of LicenseLimit units). */
export function licenseCheck(licensing) {
  const title = 'License use';
  if (missing(licensing)) return notChecked('license', title, missing(licensing));
  const limit = Number(licensing.LicenseLimit);
  if (!limit || licensing.LicenseUse === '' || licensing.LicenseUse === undefined)
    return notChecked('license', title, 'IRIS reports no license limit.');
  const use = Number(licensing.LicenseUse) || 0;
  const evidence = `${licenseUnits(use, limit)} of ${limit} license units in use (${pct(use)}).`;
  const link = [{ kind: 'link', label: 'License', hash: 'system/license' }];
  if (use >= LICENSE_FAIL_PCT)
    return row(
      'license',
      title,
      'fail',
      evidence,
      'New connections are refused when all units are taken: close idle sessions or add units.',
      link,
    );
  if (use > LICENSE_WARN_PCT)
    return row('license', title, 'warn', evidence, 'Find out who holds the units before they run out.', link);
  return row('license', title, 'ok', evidence, 'Nothing to do.');
}

/** Disk and journal space: disks of /admindeck/api/os and SystemUsage.JournalSpace of the dashboard. */
export function diskCheck(disks, journalSpace) {
  const title = 'Disk and journal space';
  if (missing(disks) && (missing(journalSpace) || !journalSpace)) return notChecked('disk', title, missing(disks));
  const found = [];
  let state = 'ok';
  const worse = (s) => {
    if (ORDER[s] < ORDER[state]) state = s;
  };
  const parts = [];
  if (!missing(disks)) {
    const own = disks.filter((d) => !d.sameFilesystemAs);
    for (const d of own) {
      const s = d.usedPct >= DISK_FAIL_PCT ? 'fail' : d.usedPct >= DISK_WARN_PCT ? 'warn' : 'ok';
      worse(s);
      if (s !== 'ok') found.push(`${d.label} (${d.path}) ${pct(d.usedPct)} used, ${fmtBytes(d.free)} free`);
    }
    if (!found.length && own.length) {
      const fullest = own.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
      parts.push(`Fullest disk: ${fullest.label} ${pct(fullest.usedPct)} used, ${fmtBytes(fullest.free)} free.`);
    }
  } else parts.push(`Disks: ${missing(disks)}.`);
  if (!missing(journalSpace) && journalSpace) {
    const s = /^normal$/i.test(journalSpace) ? 'ok' : /warn/i.test(journalSpace) ? 'warn' : 'fail';
    worse(s);
    if (s !== 'ok') found.push(`journal space ${journalSpace}`);
    else parts.push('Journal space: Normal.');
  }
  if (state === 'ok') return row('disk', title, 'ok', parts.join(' '), 'Nothing to do.');
  return row(
    'disk',
    title,
    state,
    `${list(found, 4)}.`.replace(/^./, (c) => c.toUpperCase()),
    'Free space or purge old journal files: IRIS stops writing when the journal disk is full.',
    [{ kind: 'link', label: 'Journal files', hash: 'system/journal' }],
  );
}

/** Metrics sampler: GET /admindeck/api/metrics ({interval, points: [[time, ...]], now}). */
export function samplerCheck(metrics) {
  const title = 'Metrics sampler';
  if (missing(metrics)) return notChecked('sampler', title, missing(metrics));
  const points = Array.isArray(metrics.points) ? metrics.points : [];
  const advice =
    'Start it in the package namespace with do ##class(AdminDeck.Metrics).Ensure() and look for errors in messages.log.';
  const link = [{ kind: 'link', label: 'Logs', hash: 'logs' }];
  if (!points.length) return row('sampler', title, 'fail', 'AdminDeck.Metrics has recorded no samples.', advice, link);
  const age = Math.round(metrics.now - points.at(-1)[0]);
  if (age > 3 * metrics.interval)
    return row(
      'sampler',
      title,
      'fail',
      `No new sample for ${age} s (one is expected every ${metrics.interval} s).`,
      advice,
      link,
    );
  return row(
    'sampler',
    title,
    'ok',
    `Last sample ${age} s ago; ${plural(points.length, 'sample')} kept.`,
    'Nothing to do.',
  );
}

/** Auditing: GET /v2/security/audit/enabled. */
export function auditCheck(audit) {
  const title = 'Auditing';
  if (missing(audit)) return notChecked('audit', title, missing(audit));
  if (audit.Enabled) return row('audit', title, 'ok', 'Auditing is enabled.', 'Nothing to do.');
  return row(
    'audit',
    title,
    'warn',
    'Auditing is disabled: logins and security changes are not recorded.',
    'Turn auditing on, so you can find out later who changed what.',
    [{ kind: 'link', label: 'Audit trail', hash: 'audit' }],
  );
}

/**
 * All checks, failing first, then warnings, not checked and ok (each group in a fixed order).
 * `src` = { databases, certificates, backups, tasks, taskHistory, taskManager, licensing, disks, journalSpace, metrics, audit, now }
 */
export function evaluate(src) {
  const rows = [
    dismountedCheck(src.databases),
    taskRunsCheck(src.tasks, src.taskHistory),
    backupCheck(src.backups),
    certificatesCheck(src.certificates, src.now),
    journalingCheck(src.databases),
    maxSizeCheck(src.databases),
    diskCheck(src.disks, src.journalSpace),
    licenseCheck(src.licensing),
    suspendedCheck(src.tasks, src.taskManager),
    samplerCheck(src.metrics),
    auditCheck(src.audit),
  ];
  return rows
    .map((r, i) => [r, i])
    .sort((a, b) => ORDER[a[0].state] - ORDER[b[0].state] || a[1] - b[1])
    .map(([r]) => r);
}

/** { fail, warn, unknown, ok } counts of check rows. */
export const tally = (rows) =>
  rows.reduce((n, r) => ({ ...n, [r.state]: n[r.state] + 1 }), { fail: 0, warn: 0, unknown: 0, ok: 0 });
