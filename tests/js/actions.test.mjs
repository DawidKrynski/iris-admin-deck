// Unit tests for recognising a problem in web/js/actions.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// actions.js imports the DOM toolkit and API client; the recognisers are pure, so load it with a minimal stub.
globalThis.document = { addEventListener() {}, createElement: () => ({}) };
globalThis.location = { pathname: '/admindeck/index.html', origin: 'http://x' };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { dismountedDirs, dismountedIn, loginFailureBursts } = await import('../../web/js/actions.js');

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
