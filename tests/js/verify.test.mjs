// Unit tests for web/js/verify.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedChange, normalise, same, StaleError, describeVerification } from '../../web/js/verify.js';

const notFound = () => Object.assign(new Error('ERROR #838: User x does not exist'), { status: 404 });

/** In-memory object store standing in for the SysAdmin API. */
function store(initial) {
  let obj = initial ? { ...initial } : null;
  return {
    read: async () => { if (!obj) throw notFound(); return { ...obj }; },
    set: (patch) => { obj = { ...obj, ...patch }; },
    remove: () => { obj = null; },
    get value() { return obj; },
  };
}

test('normalise treats IRIS flag and list representations as equal', () => {
  assert.ok(same(true, 1));
  assert.ok(same(false, '0'));
  assert.ok(same(['%Developer', '%Operator'], ['%Operator', '%Developer']));
  assert.ok(same({ b: 1, a: [2, 1] }, { a: [1, 2], b: true }));
  assert.ok(!same('Always', 'Never'));
  assert.equal(normalise(undefined), '');
});

test('a change that is read back is verified', async () => {
  const s = store({ Name: 'a', Enabled: true });
  const r = await verifiedChange({ read: s.read, original: s.value, changes: { Enabled: false }, write: async () => s.set({ Enabled: false }) });
  assert.equal(r.status, 'verified');
});

test('a change the server silently ignored is reported as not reflected', async () => {
  const s = store({ Enabled: true });
  const r = await verifiedChange({ read: s.read, changes: { Enabled: false }, write: async () => {} });
  assert.equal(r.status, 'not-reflected');
  assert.deepEqual(r.mismatched, ['Enabled']);
});

test('a write is refused when the object changed since it was opened', async () => {
  const s = store({ Description: 'old' });
  const original = s.value;
  s.set({ Description: 'changed by someone else' });
  let wrote = false;
  await assert.rejects(
    verifiedChange({ read: s.read, original, changes: { Description: 'mine' }, write: async () => { wrote = true; } }),
    (e) => e instanceof StaleError && e.fields.includes('Description'),
  );
  assert.equal(wrote, false);
});

test('unrelated concurrent changes do not block a write', async () => {
  const s = store({ Description: 'x', Comment: 'y' });
  const original = s.value;
  s.set({ Comment: 'changed elsewhere' });
  const r = await verifiedChange({ read: s.read, original, changes: { Description: 'z' }, write: async () => s.set({ Description: 'z' }) });
  assert.equal(r.status, 'verified');
});

test('a write is refused when the object was deleted meanwhile', async () => {
  const s = store({ Name: 'a' });
  const original = s.value;
  s.remove();
  await assert.rejects(verifiedChange({ read: s.read, original, changes: { Name: 'b' }, write: async () => {} }), StaleError);
});

test('deletion is verified when the object can no longer be read', async () => {
  const s = store({ Name: 'a' });
  assert.equal((await verifiedChange({ read: s.read, expect: 'gone', write: async () => s.remove() })).status, 'verified');
  const t = store({ Name: 'b' });
  assert.equal((await verifiedChange({ read: t.read, expect: 'gone', write: async () => {} })).status, 'not-reflected');
});

test('creation is verified when the object exists afterwards', async () => {
  const s = store(null);
  const r = await verifiedChange({ read: s.read, expect: 'exists', write: async () => s.set({ Name: 'new' }) });
  assert.equal(r.status, 'verified');
});

test('secrets are never compared and queued operations are not read back', async () => {
  const s = store({ Enabled: true });
  const r = await verifiedChange({ read: s.read, changes: { Password: 'x' }, write: async () => {} });
  assert.equal(r.status, 'unverified');
  const q = await verifiedChange({ read: s.read, write: async () => ({ GUID: '1', State: 'Queued' }) });
  assert.equal(q.status, 'unverified');
});

test('messages name the change and its outcome', () => {
  assert.equal(describeVerification({ status: 'verified', mismatched: [] }, 'Task saved')[1], 'ok');
  assert.match(describeVerification({ status: 'not-reflected', mismatched: ['Enabled'] }, 'X')[0], /Enabled/);
});

test('password policy flags are verified, password values are not', async () => {
  const s = store({ PasswordNeverExpires: false });
  const r = await verifiedChange({ read: s.read, changes: { PasswordNeverExpires: true, Password: 'x' }, write: async () => {} });
  assert.equal(r.status, 'not-reflected');
  assert.deepEqual(r.mismatched, ['PasswordNeverExpires']);
});

test('an empty expiration date equals the IRIS "no expiration" date', async () => {
  const s = store({ ExpirationDate: '2030-01-01' });
  const r = await verifiedChange({ read: s.read, changes: { ExpirationDate: '' }, write: async () => s.set({ ExpirationDate: '1840-12-31' }) });
  assert.equal(r.status, 'verified');
});

test('readable key-file paths are compared, key passwords are not', async () => {
  const s = store({ PrivateKeyFile: '/a.key' });
  const r = await verifiedChange({ read: s.read, changes: { PrivateKeyFile: '/b.key', PrivateKeyPassword: 'x' }, write: async () => {} });
  assert.deepEqual(r.mismatched, ['PrivateKeyFile']);
});
