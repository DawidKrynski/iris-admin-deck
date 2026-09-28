// Unit tests for who loses what and the last-administrator check (web/js/access.js). Run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshot,
  heldRoles,
  withChange,
  lostAccess,
  administrators,
  adminRefusal,
  reducesRole,
  capList,
  loadAccess,
  changeRoles,
} from '../../web/js/access.js';

const model = () =>
  snapshot({
    users: [
      { Name: 'SuperUser', Enabled: true, Roles: ['%All'] },
      { Name: 'ops', Enabled: true, Roles: ['Operators'] },
      { Name: 'dev', Enabled: true, Roles: ['Developers'] },
      { Name: 'old', Enabled: false, Roles: ['Operators'] },
    ],
    roles: {
      '%All': { GrantedRoles: [], Resources: [] },
      Operators: {
        GrantedRoles: ['Readers'],
        Resources: [
          { Name: '%Admin_Operate', Permissions: 'U' },
          { Name: '%DB_USER', Permissions: 'RW' },
        ],
      },
      Readers: {
        GrantedRoles: [],
        Resources: [
          { Name: '%DB_USER', Permissions: 'R' },
          { Name: '%DB_IRISAUDIT', Permissions: 'R' },
        ],
      },
      Developers: { GrantedRoles: [], Resources: [{ Name: '%Development', Permissions: 'U' }] },
    },
    resources: [
      { Name: '%Development', PublicPermission: '' },
      { Name: '%Service_Console', PublicPermission: 'U' },
    ],
  });

test('heldRoles follows roles granted through other roles, case-insensitively', () => {
  assert.deepEqual([...heldRoles(['operators'], model())].sort(), ['operators', 'readers']);
});

test('deleting a role lists the enabled holders and what they lose, not what another role still gives', () => {
  const before = model();
  const lost = lostAccess(before, withChange(before, { kind: 'deleteRole', role: 'Operators' }));
  // ops held Readers only through Operators, so its grants go too.
  assert.deepEqual(lost, [{ Name: 'ops', lost: ['%Admin_Operate:U', '%DB_IRISAUDIT:R', '%DB_USER:RW'] }]);
});

test('a letter still granted by another held role is not lost; disabled users are not listed', () => {
  const before = snapshot({
    users: [
      { Name: 'a', Enabled: true, Roles: ['X', 'Y'] },
      { Name: 'b', Enabled: false, Roles: ['X'] },
    ],
    roles: {
      X: { Resources: [{ Name: 'R1', Permissions: 'RW' }] },
      Y: { Resources: [{ Name: 'r1', Permissions: 'R' }] },
    },
  });
  const after = withChange(before, { kind: 'deleteRole', role: 'x' });
  assert.deepEqual(lostAccess(before, after), [{ Name: 'a', lost: ['R1:W'] }]);
});

test('public permissions are never lost', () => {
  const before = snapshot({
    users: [{ Name: 'a', Enabled: true, Roles: ['X'] }],
    roles: { X: { Resources: [{ Name: '%Service_Console', Permissions: 'U' }] } },
    resources: [{ Name: '%Service_Console', PublicPermission: 'U' }],
  });
  assert.deepEqual(lostAccess(before, withChange(before, { kind: 'deleteRole', role: 'X' })), []);
});

test('removing a role from a user, and lowering a permission in a role', () => {
  const before = model();
  assert.deepEqual(lostAccess(before, withChange(before, { kind: 'updateUser', user: 'dev', Roles: [] })), [
    { Name: 'dev', lost: ['%Development:U'] },
  ]);
  const lowered = withChange(before, {
    kind: 'updateRole',
    role: 'Operators',
    Resources: [
      { Name: '%Admin_Operate', Permissions: 'U' },
      { Name: '%DB_USER', Permissions: 'R' },
    ],
  });
  assert.deepEqual(lostAccess(before, lowered), [{ Name: 'ops', lost: ['%DB_USER:W'] }]);
  const ungranted = withChange(before, { kind: 'updateRole', role: 'Operators', GrantedRoles: [] });
  assert.deepEqual(lostAccess(before, ungranted), [{ Name: 'ops', lost: ['%DB_IRISAUDIT:R'] }]);
});

test('losing %All is reported as %All, and a user who keeps %All another way loses nothing', () => {
  const before = snapshot({
    users: [
      { Name: 'a', Enabled: true, Roles: ['%All'] },
      { Name: 'b', Enabled: true, Roles: ['%All', 'Admins'] },
    ],
    roles: { '%All': {}, Admins: { GrantedRoles: ['%All'] } },
  });
  const after = withChange(before, { kind: 'updateUser', user: 'a', Roles: [] });
  assert.deepEqual(lostAccess(before, after), [{ Name: 'a', lost: ['%All'] }]);
  assert.deepEqual(lostAccess(before, withChange(before, { kind: 'updateUser', user: 'b', Roles: ['Admins'] })), []);
});

test('the user being disabled or deleted is the subject, not listed as losing access', () => {
  const before = model();
  assert.deepEqual(lostAccess(before, withChange(before, { kind: 'updateUser', user: 'ops', Enabled: false })), []);
  assert.deepEqual(lostAccess(before, withChange(before, { kind: 'deleteUser', user: 'ops' })), []);
});

test('administrators counts enabled %All holders, also through a granting role', () => {
  const m = snapshot({
    users: [
      { Name: 'a', Enabled: true, Roles: ['Admins'] },
      { Name: 'b', Enabled: false, Roles: ['%All'] },
      { Name: 'c', Enabled: true, Roles: [] },
    ],
    roles: { '%All': {}, Admins: { GrantedRoles: ['%ALL'] } },
  });
  assert.deepEqual(administrators(m), ['a']);
});

test('adminRefusal refuses every change that leaves no enabled %All holder', () => {
  const before = snapshot({
    users: [
      { Name: 'boss', Enabled: true, Roles: ['Admins'] },
      { Name: 'x', Enabled: true, Roles: [] },
    ],
    roles: { '%All': {}, Admins: { GrantedRoles: ['%All'] } },
  });
  for (const change of [
    { kind: 'deleteRole', role: 'Admins' },
    { kind: 'updateRole', role: 'Admins', GrantedRoles: [] },
    { kind: 'updateUser', user: 'boss', Roles: [] },
    { kind: 'updateUser', user: 'BOSS', Enabled: false },
    { kind: 'deleteUser', user: 'boss' },
  ]) {
    const refusal = adminRefusal(before, withChange(before, change));
    assert.match(refusal || '', /no enabled user would hold %All.*boss/, JSON.stringify(change));
  }
  assert.equal(adminRefusal(before, withChange(before, { kind: 'deleteUser', user: 'x' })), null);
  const two = withChange(before, { kind: 'updateUser', user: 'x', Roles: ['%All'] });
  assert.equal(adminRefusal(two, withChange(two, { kind: 'deleteUser', user: 'boss' })), null, 'another admin is left');
  const none = snapshot({ users: [{ Name: 'x', Enabled: true, Roles: [] }] });
  assert.equal(adminRefusal(none, withChange(none, { kind: 'deleteUser', user: 'x' })), null, 'nothing to protect');
});

test('withChange does not modify the snapshot it is given', () => {
  const before = model();
  withChange(before, { kind: 'deleteRole', role: 'Readers' });
  withChange(before, { kind: 'updateUser', user: 'ops', Roles: [] });
  assert.deepEqual(before.roles.get('operators').GrantedRoles, ['Readers']);
  assert.deepEqual(before.users[1].Roles, ['Operators']);
  assert.throws(() => withChange(before, { kind: 'rename' }), /Unknown change/);
});

test('reducesRole: a removed letter, resource or granted role reduces; additions do not', () => {
  const role = { GrantedRoles: ['Readers'], Resources: [{ Name: '%DB_USER', Permissions: 'RW' }] };
  assert.equal(reducesRole(role, { Resources: [{ Name: '%DB_USER', Permissions: 'R' }] }), true);
  assert.equal(reducesRole(role, { Resources: [] }), true);
  assert.equal(reducesRole(role, { GrantedRoles: [] }), true);
  assert.equal(
    reducesRole(role, { Resources: [{ Name: '%db_user', Permissions: 'WRU' }], GrantedRoles: ['readers', 'X'] }),
    false,
  );
  assert.equal(reducesRole(role, { Description: 'x' }), false);
});

test('capList shows at most max items and counts the rest', () => {
  const names = Array.from({ length: 25 }, (_, i) => `u${i}`);
  assert.deepEqual(capList(names, 20).more, 5);
  assert.equal(capList(names, 20).shown.length, 20);
  assert.deepEqual(capList(['a']), { shown: ['a'], more: 0 });
});

test('loadAccess reads enabled users, then every role they reach (and the extra role), once each', async () => {
  const calls = [];
  const data = {
    '/v2/security/users': [
      { Name: 'a', Enabled: true },
      { Name: 'off', Enabled: false },
    ],
    '/v2/security/resources': [{ Name: 'P', PublicPermission: 'R' }],
    'user:a': { Roles: ['Outer', 'outer'] },
    'role:Outer': { GrantedRoles: ['Inner'], Resources: [] },
    'role:Inner': { GrantedRoles: ['Outer'], Resources: [{ Name: 'X', Permissions: 'U' }] },
    'role:Lonely': { GrantedRoles: [], Resources: [] },
  };
  const get = async (path, q) => {
    calls.push(q ? `${path}?${q.name}` : path);
    if (path === '/v2/security/user') return data[`user:${q.name}`];
    if (path === '/v2/security/role') return data[`role:${q.name}`];
    return data[path];
  };
  const m = await loadAccess(get, ['Lonely']);
  assert.deepEqual([...m.roles.keys()].sort(), ['inner', 'lonely', 'outer']);
  assert.equal(calls.filter((c) => c.startsWith('/v2/security/role?')).length, 3, 'each role read once');
  assert.ok(!calls.includes('/v2/security/user?off'), 'disabled users are not read');
  assert.deepEqual(
    m.users.find((u) => u.Name === 'off'),
    { Name: 'off', Enabled: false, Roles: [] },
  );
});

test('replacing the only %All with another role that grants %All is allowed: proposed roles are read too', async () => {
  const data = {
    '/v2/security/users': [{ Name: 'SuperUser', Enabled: true }],
    '/v2/security/resources': [],
    'user:SuperUser': { Roles: ['%All'] },
    'role:%All': { GrantedRoles: [], Resources: [] },
    'role:Admins': { GrantedRoles: ['Wrapper'], Resources: [] }, // held by nobody yet; grants %All two levels down
    'role:Wrapper': { GrantedRoles: ['%All'], Resources: [] },
    'role:Plain': { GrantedRoles: [], Resources: [] },
  };
  const get = async (path, q) =>
    path === '/v2/security/user'
      ? data[`user:${q.name}`]
      : path === '/v2/security/role'
        ? data[`role:${q.name}`]
        : data[path];
  const check = async (change) => {
    const before = await loadAccess(get, changeRoles(change));
    return adminRefusal(before, withChange(before, change));
  };
  assert.deepEqual(changeRoles({ kind: 'updateUser', user: 'a', Roles: ['X'] }), ['X']);
  assert.deepEqual(changeRoles({ kind: 'updateRole', role: 'R', GrantedRoles: ['G'] }), ['R', 'G']);
  assert.equal(await check({ kind: 'updateUser', user: 'SuperUser', Roles: ['Admins'] }), null, 'Admins grants %All');
  assert.match(await check({ kind: 'updateUser', user: 'SuperUser', Roles: ['Plain'] }), /^Refused/, 'Plain does not');
});
