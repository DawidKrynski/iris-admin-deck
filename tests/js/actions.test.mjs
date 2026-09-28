// Unit tests for recognising a problem in web/js/actions.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// actions.js imports the DOM toolkit and API client; the recognisers are pure, so load it with a minimal stub.
globalThis.document = { addEventListener() {}, createElement: () => ({}) };
globalThis.location = { pathname: '/admindeck/index.html', origin: 'http://x' };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { dismountedDirs, dismountedIn, loginFailureBursts, backupFinding } = await import('../../web/js/actions.js');

test('backupFinding reports a missing, old or failed backup and nothing for a recent one', () => {
  const run = (ok, ageDays, type = 'Full') => ({ ok, ageDays, type, time: `t-${ageDays}`, status: ok ? 'Completed' : 'Failed' });
  assert.deepEqual(backupFinding({ history: [] }), { never: true, failed: 0, lastFailed: null });
  assert.equal(backupFinding(null).never, true);
  assert.equal(backupFinding({ history: [run(false, 1)] }).failed, 1, 'only failed runs: still never');
  assert.equal(backupFinding({ history: [run(true, 2)] }), null, 'recent success');
  assert.deepEqual(backupFinding({ history: [run(true, 9, 'Incremental'), run(true, 30)] }, 7),
    { never: false, days: 9, type: 'Incremental', time: 't-9', lastFailed: null }, 'newest success of any type, older than the limit');
  assert.equal(backupFinding({ history: [run(false, 0), run(true, 1)] }).lastFailed.status, 'Failed', 'newest run failed');
  assert.equal(backupFinding({ history: [run(true, null)] }), null, 'unknown age is not reported as old');
});

test('backupFinding uses the last successful backups of the whole history, not only the listed page', () => {
  const run = (ok, ageDays, type = 'Full') => ({ ok, ageDays, type, time: `t-${ageDays}`, status: ok ? 'Completed' : 'Failed' });
  // The page holds only failed runs, but a successful full backup ran 2 days ago (beyond the display limit)
  const page = [run(false, 0), run(false, 1)];
  const f = backupFinding({ history: page, lastSuccessful: { Full: run(true, 2) } });
  assert.equal(f.never, false, 'not "never" when an older successful backup exists');
  assert.equal(f.days, 2);
  assert.equal(f.lastFailed.status, 'Failed');
  assert.equal(backupFinding({ history: [run(false, 0)], lastSuccessful: { Full: run(true, 30), Incremental: run(true, 3, 'Incremental') } }, 7).days, 3,
    'newest success of any type');
  assert.equal(backupFinding({ history: [], lastSuccessful: { Full: run(true, 1) } }), null, 'recent success beyond the page');
  assert.deepEqual(backupFinding({ history: [run(false, 0)], lastSuccessful: {} }), { never: true, failed: 1, lastFailed: page[0] });
});

test('dismountedDirs keeps only dismounted directories', () => {
  assert.deepEqual(dismountedDirs([
    { Directory: '/mgr/', Status: 'Mounted/RW' }, { Directory: '/mgr/lib/', Status: 'Mounted/R' },
    { Directory: '/mgr/app/', Status: 'Dismounted' },
  ]), ['/mgr/app/']);
  assert.deepEqual(dismountedDirs(null), []);
});

test('dismountedIn reads the directory from a messages.log line', () => {
  assert.equal(dismountedIn('[Generic.Event] Dismounted database /usr/irissys/mgr/app/ (SFN 11)'), '/usr/irissys/mgr/app/');
  assert.equal(dismountedIn('Mounted database /usr/irissys/mgr/app/ (SFN 11) read-write.'), null);
  assert.equal(dismountedIn(undefined), null);
});

test('loginFailureBursts counts LoginFailure events per user from the threshold up', () => {
  const fail = (user) => ({ event: 'LoginFailure', user });
  const rows = [fail('bob'), fail('bob'), fail('bob'), fail('eve'), { event: 'Login', user: 'eve' }, { event: 'LoginFailure' }];
  assert.deepEqual([...loginFailureBursts(rows, 3)], [['bob', 3]]);
  assert.equal(loginFailureBursts(rows).size, 0);
});
