// Who loses what before a security change, and whether an administrator is left afterwards.
// Pure functions over a snapshot {users, roles, resources} so they run in node tests; loadAccess()
// takes the API getter as an argument for the same reason.
//
// IRIS quirks this relies on:
//   - role and resource names are case-insensitive;
//   - a role can grant other roles (GrantedRoles), so what a user holds is the closure of their roles;
//   - %All grants every permission on every resource, whatever its own Resources list says (IRIS lets
//     you PUT Resources on %All and ignores them);
//   - DELETE of %All answers 200 and leaves the role in place, so the only ways to lose the last
//     administrator are removing %All (or a role that grants it) from users, deleting such a role,
//     and disabling or deleting the users who hold it;
//   - escalation roles are held only after the user escalates, so they are not counted here.

const ALL = '%all';
const key = (name) => String(name).toLowerCase();
const LETTERS = ['R', 'W', 'U'];

/** Snapshot with lower-case role keys: {users: [{Name, Enabled, Roles}], roles: Map, public: Map}. */
export function snapshot({ users = [], roles = {}, resources = [] }) {
  const roleMap = new Map();
  for (const [name, r] of roles instanceof Map ? roles : Object.entries(roles)) {
    roleMap.set(key(name), { Name: r.Name || name,GrantedRoles: [...(r.GrantedRoles || [])], Resources: (r.Resources || []).map((x) => ({ ...x })) });
  }
  const pub = new Map();
  for (const r of resources) if (r.PublicPermission) pub.set(key(r.Name), { Name: r.Name, Permissions: r.PublicPermission });
  return { users: users.map((u) => ({ Name: u.Name, Enabled: !!u.Enabled, Roles: [...(u.Roles || [])] })), roles: roleMap, public: pub };
}

/** Lower-case names of every role `direct` gives, including roles granted through other roles. */
export function heldRoles(direct, model) {
  const held = new Set(); const queue = direct.map(key);
  while (queue.length) {
    const r = queue.shift(); if (held.has(r)) continue;
    held.add(r);
    for (const g of (model.roles.get(r) || {}).GrantedRoles || []) queue.push(key(g));
  }
  return held;
}

/** Effective access of a user: {all} for %All holders, else {grants: Map resource -> {Name, letters: Set}}. */
export function effective(user, model) {
  const roles = heldRoles(user.Roles, model);
  if (roles.has(ALL)) return { all: true, grants: new Map() };
  const grants = new Map();
  const add = (name, perms) => {
    const k = key(name); if (!grants.has(k)) grants.set(k, { Name: name, letters: new Set() });
    for (const p of LETTERS) if (String(perms || '').toUpperCase().includes(p)) grants.get(k).letters.add(p);
  };
  for (const r of roles) for (const res of (model.roles.get(r) || {}).Resources || []) add(res.Name, res.Permissions);
  for (const res of model.public.values()) add(res.Name, res.Permissions);
  return { all: false, grants };
}

/**
 * The snapshot after `change`:
 *   {kind: 'deleteRole', role}                       IRIS also drops it from users and from other roles
 *   {kind: 'updateRole', role, GrantedRoles?, Resources?}
 *   {kind: 'updateUser', user, Roles?, Enabled?}
 *   {kind: 'deleteUser', user}
 */
export function withChange(model, change) {
  const roles = new Map([...model.roles].map(([k, r]) => [k, { ...r, GrantedRoles: [...r.GrantedRoles], Resources: [...r.Resources] }]));
  let users = model.users.map((u) => ({ ...u, Roles: [...u.Roles] }));
  const target = key(change.role || change.user || '');
  if (change.kind === 'deleteRole') {
    roles.delete(target);
    for (const r of roles.values()) r.GrantedRoles = r.GrantedRoles.filter((g) => key(g) !== target);
    for (const u of users) u.Roles = u.Roles.filter((g) => key(g) !== target);
  } else if (change.kind === 'updateRole') {
    const r = roles.get(target) || { Name: change.role, GrantedRoles: [], Resources: [] };
    if (change.GrantedRoles) r.GrantedRoles = [...change.GrantedRoles];
    if (change.Resources) r.Resources = change.Resources.map((x) => ({ ...x }));
    roles.set(target, r);
  } else if (change.kind === 'updateUser') {
    users = users.map((u) => (key(u.Name) !== target ? u : {
      ...u, ...(change.Roles ? { Roles: [...change.Roles] } : {}), ...('Enabled' in change ? { Enabled: !!change.Enabled } : {}),
    }));
  } else if (change.kind === 'deleteUser') {
    users = users.filter((u) => key(u.Name) !== target);
  } else throw new Error(`Unknown change: ${change.kind}`);
  return { users, roles, public: model.public };
}

/**
 * Enabled users (before and after: a user being disabled or deleted is the subject, not collateral) who
 * lose something, sorted by name: [{Name, lost: ['%DB_USER:W', …]}], or lost ['%All'] for the %All role.
 */
export function lostAccess(before, after) {
  const now = new Map(after.users.filter((u) => u.Enabled).map((u) => [key(u.Name), u]));
  const out = [];
  for (const u of before.users) {
    if (!u.Enabled || !now.has(key(u.Name))) continue;
    const b = effective(u, before); const a = effective(now.get(key(u.Name)), after);
    if (a.all) continue;
    if (b.all) { out.push({ Name: u.Name, lost: ['%All'] }); continue; }
    const lost = [];
    for (const [k, g] of b.grants) {
      const left = a.grants.get(k);
      const gone = LETTERS.filter((p) => g.letters.has(p) && !(left && left.letters.has(p))).join('');
      if (gone) lost.push(`${g.Name}:${gone}`);
    }
    if (lost.length) out.push({ Name: u.Name, lost: lost.sort((x, y) => x.localeCompare(y)) });
  }
  return out.sort((x, y) => x.Name.localeCompare(y.Name));
}

/** Names of the enabled users holding %All (directly or through another role). */
export function administrators(model) {
  return model.users.filter((u) => u.Enabled && heldRoles(u.Roles, model).has(ALL)).map((u) => u.Name);
}

/** Refusal text when `after` leaves no enabled %All holder and `before` had one; null otherwise. */
export function adminRefusal(before, after) {
  const was = administrators(before);
  if (!was.length || administrators(after).length) return null;
  return `Refused: after this change no enabled user would hold %All (now: ${was.join(', ')}). Give %All to another enabled user first.`;
}

/** True when `updated` takes something away from a role: a granted role, or a letter of a resource grant. */
export function reducesRole(original, updated) {
  if ('GrantedRoles' in updated) {
    const kept = new Set((updated.GrantedRoles || []).map(key));
    if ((original.GrantedRoles || []).some((g) => !kept.has(key(g)))) return true;
  }
  if ('Resources' in updated) {
    const next = new Map((updated.Resources || []).map((r) => [key(r.Name), String(r.Permissions || '').toUpperCase()]));
    for (const r of original.Resources || []) {
      const left = next.get(key(r.Name)) || '';
      if (LETTERS.some((p) => String(r.Permissions || '').toUpperCase().includes(p) && !left.includes(p))) return true;
    }
  }
  return false;
}

/**
 * Roles loadAccess() must read for `change` besides those users hold now: the changed role and the roles it
 * proposes (Roles of a user, GrantedRoles of a role), so a replacement that grants %All is counted.
 */
export function changeRoles(change) {
  return [change.role, ...(change.Roles || []), ...(change.GrantedRoles || [])].filter(Boolean);
}

/** The first `max` items and how many were left out. */
export function capList(items, max = 20) {
  return { shown: items.slice(0, max), more: Math.max(0, items.length - max) };
}

/**
 * Reads the snapshot through `get(path, query)` (admin.get). The lists carry neither the roles of a user
 * nor the grants of a role, so it reads each enabled user and then every role they reach, plus `extraRoles`.
 */
export async function loadAccess(get, extraRoles = []) {
  const [list, resources] = await Promise.all([get('/v2/security/users'), get('/v2/security/resources')]);
  const users = await Promise.all(list.map(async (u) => (u.Enabled
    ? { Name: u.Name, Enabled: true, Roles: (await get('/v2/security/user', { name: u.Name })).Roles || [] }
    : { Name: u.Name, Enabled: false, Roles: [] })));
  const roles = new Map();
  const next = (names) => {
    const wave = new Map(); // key -> the first spelling seen
    for (const n of names) if (!roles.has(key(n)) && !wave.has(key(n))) wave.set(key(n), n);
    return [...wave];
  };
  let wave = next([...users.flatMap((u) => u.Roles), ...extraRoles]);
  while (wave.length) {
    const read = await Promise.all(wave.map(async ([k, name]) => [k, name, await get('/v2/security/role', { name })]));
    for (const [k, name, r] of read) roles.set(k, { ...r, Name: name });
    wave = next(read.flatMap(([, , r]) => r.GrantedRoles || []));
  }
  return snapshot({ users, roles, resources });
}
