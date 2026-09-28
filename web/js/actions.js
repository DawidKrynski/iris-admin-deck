// Next steps offered on the problem itself: a dismounted database can be mounted, a failed task run
// again, an expiring certificate or a user with failed logins opened — right where the dashboard
// or the timeline shows it. Recognising the problem is pure (and unit-tested); every write still
// goes through confirmAction with the API call preview and a read-back. Callers check privileges.
import { admin, findInList } from './api.js';
import { h, confirmAction } from './ui.js';

// ---------- recognising a problem ----------
const isDismounted = (status) => /^dismounted/i.test(String(status || ''));

/** Directories of /v2/database-dirs rows that are dismounted. */
export const dismountedDirs = (rows) =>
  (Array.isArray(rows) ? rows : []).filter((r) => isDismounted(r.Status)).map((r) => r.Directory);

/** Directory named by a messages.log line such as "Dismounted database /data/app/ (SFN 11)", else null. */
export const dismountedIn = (text) => (/\bDismounted database (\S+)/i.exec(String(text || '')) || [])[1] || null;

/** Users with at least `min` LoginFailure audit events among timeline rows ({event, user}): Map user -> count. */
export function loginFailureBursts(rows, min = 5) {
  const counts = new Map();
  for (const r of rows)
    if (r.user && /LoginFailure/i.test(r.event || '')) counts.set(r.user, (counts.get(r.user) || 0) + 1);
  return new Map([...counts].filter(([, n]) => n >= min));
}

/** Days without a successful backup after which the dashboard asks for attention. */
export const BACKUP_MAX_AGE_DAYS = 7;

/**
 * Backup finding from GET /admindeck/api/backups (history newest first, rows {ok, ageDays, type, time};
 * lastSuccessful {type: row} computed by the server over the whole history, which `history` may cut short):
 *   null                                  a successful backup ran within `maxDays` (or its age is unknown)
 *   {never: true, failed}                 no successful backup is recorded; `failed` = failed runs recorded
 *   {never: false, days, type, time}      the newest successful backup is older than `maxDays`
 * `lastFailed` is added when the newest recorded backup run did not succeed.
 */
export function backupFinding(summary, maxDays = BACKUP_MAX_AGE_DAYS) {
  const history = summary && Array.isArray(summary.history) ? summary.history : [];
  // The newest successful run of each type; only a server without lastSuccessful falls back to the (limited) list.
  const perType =
    summary && summary.lastSuccessful && typeof summary.lastSuccessful === 'object'
      ? Object.values(summary.lastSuccessful)
      : null;
  const ok = (perType || history).filter((r) => r && r.ok);
  const lastFailed = history.length && !history[0].ok ? history[0] : null;
  if (!ok.length) return { never: true, failed: history.length, lastFailed };
  const ages = ok.map((r) => r.ageDays).filter((d) => typeof d === 'number');
  if (!ages.length) return lastFailed ? { never: false, days: null, lastFailed } : null;
  const newest = ok.find((r) => r.ageDays === Math.min(...ages));
  if (newest.ageDays > maxDays)
    return { never: false, days: newest.ageDays, type: newest.type, time: newest.time, lastFailed };
  return lastFailed ? { never: false, days: newest.ageDays, type: newest.type, time: newest.time, lastFailed } : null;
}

// ---------- presenting the next step ----------
/** Quiet group of next steps placed at the end of an item line; nothing when there is none. */
export function nextSteps(...steps) {
  const list = steps.flat().filter(Boolean);
  return list.length ? h('span.next-steps', list) : null;
}
/** Read-only step: a deep link into the screen that owns the object. */
export const openLink = (label, hash, title) => h('a.next-step', { href: `#/${hash}`, title }, label);
/** Step that does something (a confirmation dialog follows). */
export const stepButton = (label, onclick, title) => h('button.small.next-step', { onclick, title }, label);

// ---------- the writes ----------
async function readMounted(dir) {
  const row = await findInList('/v2/database-dirs', {}, 'Directory', dir);
  return { Mounted: /^mounted(?:\/|$)/i.test(String(row.Status || '')) };
}

/** "Mount" for a dismounted database directory; `onDone` runs after a confirmed mount. */
export function mountStep(dir, onDone) {
  return stepButton(
    'Mount',
    () =>
      confirmAction({
        title: `Mount ${dir}`,
        message: 'The database will become available to applications again.',
        call: { method: 'POST', path: `/api/admin/v2/database-dir/mount?${new URLSearchParams({ dir })}`, body: {} },
        confirmLabel: 'Mount',
        run: () => admin.post('/v2/database-dir/mount', {}, { dir }),
        verify: { read: () => readMounted(dir), changes: { Mounted: true } },
        done: 'Database mounted',
      }).then((ok) => {
        if (ok && onDone) onDone();
      }),
    'Mount this database (the read-back confirms it)',
  );
}

/** "Run again" for a task: the same confirmation and call as Run now on the Tasks screen. */
export function runAgainStep(id, name) {
  return stepButton(
    'Run again',
    async () => (await import('./screens/tasks.js')).runTask({ Id: id, Name: name }),
    'Queue this task now, in addition to its schedule',
  );
}
