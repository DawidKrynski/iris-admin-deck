// Unit tests for the Status health checks in web/js/checks.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// checks.js reuses actions.js, which imports the DOM toolkit and API client: load it with a minimal stub.
globalThis.document = { addEventListener() {}, createElement: () => ({}) };
globalThis.location = { pathname: '/admindeck/index.html', origin: 'http://x' };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const c = await import('../../web/js/checks.js');

const NA = { unavailable: 'Needs the Secure privilege.' };
const db = (Name, extra = {}) => ({
  Name,
  Directory: `/mgr/${Name.toLowerCase()}/`,
  Status: 'Mounted/RW',
  Size: 10,
  MaxSize: 'Unlimited',
  GlobalJournalState: true,
  ...extra,
});
const assertUnknown = (r, reason = NA.unavailable) => {
  assert.equal(r.state, 'unknown');
  assert.equal(r.evidence, reason);
};

test('dismounted: ok, fail with a Mount step per database, not checked', () => {
  assert.equal(c.dismountedCheck([db('USER')]).state, 'ok');
  const r = c.dismountedCheck([db('USER'), db('REPORTS', { Status: 'Dismounted' })]);
  assert.equal(r.state, 'fail');
  assert.match(r.evidence, /REPORTS \(\/mgr\/reports\/\)/);
  assert.deepEqual(r.steps, [{ kind: 'mount', dir: '/mgr/reports/', name: 'REPORTS' }]);
  assertUnknown(c.dismountedCheck(NA));
  assertUnknown(c.dismountedCheck(null), 'Not read');
});

test('journaling: off is a warning, IRISTEMP, IRISLOCALDATA and read-only databases do not count', () => {
  const quiet = [
    db('IRISTEMP', { GlobalJournalState: false }),
    db('IRISLOCALDATA', { GlobalJournalState: false }),
    db('IRISLIB', { GlobalJournalState: false, Status: 'Mounted/R' }),
    db('ARCHIVE', { GlobalJournalState: false, ReadOnly: true }),
  ];
  assert.equal(c.journalingCheck([db('USER'), ...quiet]).state, 'ok');
  const r = c.journalingCheck([db('USER'), db('APP', { GlobalJournalState: false })]);
  assert.equal(r.state, 'warn');
  assert.match(r.evidence, /off for APP/);
  assert.equal(r.steps[0].hash, 'system/databases');
  assert.match(
    c.journalingCheck([db('USER'), db('X', { GlobalJournalState: undefined })]).evidence,
    /1 could not be read/,
  );
  assert.equal(c.journalingCheck([db('USER', { GlobalJournalState: undefined })]).state, 'unknown', 'nothing read');
  assertUnknown(c.journalingCheck(NA));
});

test('max size: unlimited or roomy is ok, 90 % warns, 98 % fails', () => {
  assert.match(c.maxSizeCheck([db('USER')]).evidence, /No database has a maximum size/);
  assert.equal(c.maxSizeCheck([db('APP', { Size: 50, MaxSize: '100' })]).state, 'ok');
  const warn = c.maxSizeCheck([db('APP', { Size: 92, MaxSize: '100' }), db('B', { Size: 1, MaxSize: 100 })]);
  assert.equal(warn.state, 'warn');
  assert.match(warn.evidence, /APP 92 of 100 MB \(92 %\)/);
  assert.doesNotMatch(warn.evidence, /\bB\b/);
  assert.equal(c.maxSizeCheck([db('APP', { Size: 99, MaxSize: 100 })]).state, 'fail');
  assertUnknown(c.maxSizeCheck(NA));
});

test('certificates: expired fails, under 30 days warns with a link, later is ok', () => {
  const now = Date.parse('2026-09-28T00:00:00Z');
  const cert = (alias, date) => ({ alias, date });
  assert.equal(c.certificatesCheck([], now).state, 'ok');
  assert.equal(c.certificatesCheck([cert('a', '2027-01-01')], now).state, 'ok');
  const warn = c.certificatesCheck([cert('far', '2027-01-01'), cert('soon', '2026-10-10')], now);
  assert.equal(warn.state, 'warn');
  assert.match(warn.evidence, /soon expires in 12 days/);
  assert.deepEqual(warn.steps, [{ kind: 'link', label: 'Open soon', hash: 'secrets/x509/soon' }]);
  const fail = c.certificatesCheck([cert('soon', '2026-10-10'), cert('old', '2026-09-01')], now);
  assert.equal(fail.state, 'fail');
  assert.match(fail.evidence, /^old expired/);
  assert.equal(c.certificatesCheck([cert('x', null)], now).state, 'unknown', 'unreadable certificate');
  assertUnknown(c.certificatesCheck(NA, now));
});

test('backups: recent is ok, none or old warns, a failed newest run fails', () => {
  const run = (ok, ageDays) => ({
    ok,
    ageDays,
    type: 'Full',
    time: `t-${ageDays}`,
    status: ok ? 'Completed' : 'Failed',
  });
  const ok = c.backupCheck({ history: [run(true, 2)] });
  assert.equal(ok.state, 'ok');
  assert.match(ok.evidence, /2 days ago/);
  assert.match(c.backupCheck({ history: [] }).evidence, /No successful backup/);
  assert.equal(c.backupCheck({ history: [] }).state, 'warn');
  assert.equal(c.backupCheck({ history: [run(true, 9)] }).state, 'warn');
  const fail = c.backupCheck({ history: [run(false, 0), run(true, 1)] });
  assert.equal(fail.state, 'fail');
  assert.match(fail.evidence, /did not succeed: Failed/);
  assert.equal(fail.steps[0].hash, 'system/backups');
  assertUnknown(c.backupCheck(NA));
});

test('task runs: the newest run of each task decides; a failure offers Run again and the task', () => {
  const tasks = [
    { Id: 1001, Name: 'Sales export' },
    { Id: 1, Name: 'Switch Journal' },
  ];
  const okRun = { TaskId: 1001, ErrNumber: 0, Result: 'Success', LogDatetime: '2026-09-28 08:10:00' };
  const badRun = { TaskId: 1001, ErrNumber: 0, Result: 'ERROR #5002: <PROTECT>', Completed: '2026-09-28 08:05:00' };
  assert.equal(c.taskRunsCheck(tasks, [okRun, badRun]).state, 'ok', 'passed after the failure');
  const r = c.taskRunsCheck(tasks, [badRun, okRun, { TaskId: 99, ErrNumber: 5 }]);
  assert.equal(r.state, 'fail');
  assert.match(r.evidence, /Sales export \(#1001\) at 2026-09-28 08:05:00: ERROR #5002/);
  assert.deepEqual(r.steps, [
    { kind: 'run', id: 1001, name: 'Sales export' },
    { kind: 'link', label: 'Open Sales export', hash: 'tasks/1001' },
  ]);
  assert.equal(c.taskRunsCheck(tasks, [{ TaskId: 1, ErrNumber: 3 }]).state, 'fail', 'ErrNumber alone');
  assertUnknown(c.taskRunsCheck(NA, []));
  assertUnknown(c.taskRunsCheck(tasks, NA));
});

test('Task Manager: suspended manager fails, suspended tasks warn', () => {
  const tasks = [
    { Id: 1, Name: 'A', Suspended: false },
    { Id: 2, Name: 'B', Suspended: true },
  ];
  assert.equal(c.suspendedCheck([tasks[0]], { Status: 'Running' }).state, 'ok');
  const warn = c.suspendedCheck(tasks, { Status: 'Running' });
  assert.equal(warn.state, 'warn');
  assert.match(warn.evidence, /suspended: B \(#2\)/);
  assert.equal(c.suspendedCheck(tasks, { Status: 'Suspended' }).state, 'fail');
  assert.equal(c.suspendedCheck(NA, { Status: 'Suspended' }).state, 'fail', 'manager alone is enough');
  assert.equal(c.suspendedCheck(tasks, NA).state, 'warn', 'tasks alone are enough');
  assertUnknown(c.suspendedCheck(NA, NA));
});

test('license: above 80 % warns, 95 % fails, no limit is not checked', () => {
  const ok = c.licenseCheck({ LicenseLimit: 8, LicenseUse: 25 });
  assert.equal(ok.state, 'ok');
  assert.match(ok.evidence, /2 of 8 license units in use \(25 %\)/);
  assert.equal(c.licenseCheck({ LicenseLimit: 8, LicenseUse: 80 }).state, 'ok');
  assert.equal(c.licenseCheck({ LicenseLimit: 8, LicenseUse: 88 }).state, 'warn');
  assert.equal(c.licenseCheck({ LicenseLimit: 8, LicenseUse: 100 }).state, 'fail');
  assert.equal(c.licenseCheck({ LicenseLimit: '', LicenseUse: '' }).state, 'unknown');
  assertUnknown(c.licenseCheck(NA));
});

test('disk and journal space: disks of one filesystem count once; 85 % warns, 95 % or a journal alert fails', () => {
  const disk = (label, usedPct, same = null) => ({
    label,
    path: `/${label}/`,
    usedPct,
    free: 1073741824,
    sameFilesystemAs: same,
  });
  const ok = c.diskCheck([disk('Install', 58), disk('Journal', 99, 'Install')], 'Normal');
  assert.equal(ok.state, 'ok');
  assert.match(ok.evidence, /Install 58 % used, 1.0 GB free\. Journal space: Normal/);
  const warn = c.diskCheck([disk('Install', 90)], 'Normal');
  assert.equal(warn.state, 'warn');
  assert.match(warn.evidence, /^Install \(\/Install\/\) 90 % used/);
  assert.equal(c.diskCheck([disk('Install', 96)], '').state, 'fail');
  assert.equal(c.diskCheck([disk('Install', 10)], 'Warning').state, 'warn');
  assert.equal(c.diskCheck([disk('Install', 10)], 'Troubled').state, 'fail');
  assert.equal(c.diskCheck(NA, 'Troubled').state, 'fail', 'journal space alone is enough');
  assertUnknown(c.diskCheck(NA, ''));
});

test('metrics sampler: fresh samples are ok, none or stale fail', () => {
  assert.equal(c.samplerCheck({ interval: 5, now: 1000, points: [[990], [995]] }).state, 'ok');
  const none = c.samplerCheck({ interval: 5, now: 1000, points: [] });
  assert.equal(none.state, 'fail');
  assert.match(none.advice, /AdminDeck\.Metrics\)\.Ensure\(\)/);
  assert.match(c.samplerCheck({ interval: 5, now: 1000, points: [[900]] }).evidence, /No new sample for 100 s/);
  assertUnknown(c.samplerCheck(NA));
});

test('auditing: disabled warns with a link to the audit screen', () => {
  assert.equal(c.auditCheck({ Enabled: true }).state, 'ok');
  const r = c.auditCheck({ Enabled: false });
  assert.equal(r.state, 'warn');
  assert.equal(r.steps[0].hash, 'audit');
  assertUnknown(c.auditCheck(NA));
});

test('evaluate: every check once, failing first, then warnings, not checked, ok', () => {
  const rows = c.evaluate({
    databases: [db('USER'), db('REPORTS', { Status: 'Dismounted' })],
    certificates: NA,
    backups: { history: [] },
    tasks: [{ Id: 1001, Name: 'Sales export', Suspended: false }],
    taskHistory: [{ TaskId: 1001, ErrNumber: 0, Result: 'ERROR #5002' }],
    taskManager: { Status: 'Running' },
    licensing: { LicenseLimit: 8, LicenseUse: 0 },
    disks: [],
    journalSpace: 'Normal',
    metrics: { interval: 5, now: 10, points: [[9]] },
    audit: { Enabled: true },
  });
  assert.equal(rows.length, 11);
  assert.equal(new Set(rows.map((r) => r.id)).size, 11);
  assert.deepEqual(
    rows.slice(0, 3).map((r) => [r.id, r.state]),
    [
      ['dismounted', 'fail'],
      ['taskruns', 'fail'],
      ['backup', 'warn'],
    ],
  );
  assert.deepEqual(rows[3], { ...rows[3], id: 'certificates', state: 'unknown' });
  assert.ok(rows.slice(4).every((r) => r.state === 'ok'));
  assert.deepEqual(c.tally(rows), { fail: 2, warn: 1, unknown: 1, ok: 7 });
});

test('check copy is plain: no em-dashes in any row', () => {
  const rows = c.evaluate({
    databases: [db('A', { Status: 'Dismounted', GlobalJournalState: false, Size: 99, MaxSize: 100 })],
    certificates: [{ alias: 'x', date: '2000-01-01' }],
    backups: { history: [] },
    tasks: [],
    taskHistory: [],
    taskManager: { Status: 'Suspended' },
    licensing: { LicenseLimit: 8, LicenseUse: 100 },
    disks: [{ label: 'D', path: '/', usedPct: 99, free: 1 }],
    journalSpace: 'Troubled',
    metrics: { interval: 5, now: 10, points: [] },
    audit: { Enabled: false },
  });
  for (const r of rows) assert.doesNotMatch(`${r.title} ${r.evidence} ${r.advice}`, /—/, r.id);
});
