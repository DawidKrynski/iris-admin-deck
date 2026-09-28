// The `check` of confirmAction for security changes: reads users and roles now, applies the change to that
// snapshot (access.js) and lists who loses what; refuses when no enabled %All holder would be left.
import { admin } from './api.js';
import { h } from './ui.js';
import { loadAccess, withChange, lostAccess, adminRefusal, capList, changeRoles } from './access.js';

const MAX_USERS = 20; const MAX_GRANTS = 12;

/** `list: false` for disabling or deleting a user: only the administrator check applies. */
export const accessCheck = (change, { list = true } = {}) => async () => {
  // The proposed roles too (and what they grant, recursively): loadAccess only reaches roles held now.
  const before = await loadAccess((path, query) => admin.get(path, query), changeRoles(change));
  const after = withChange(before, change);
  const refuse = adminRefusal(before, after);
  if (!list) return { body: null, refuse };
  const { shown, more } = capList(lostAccess(before, after), MAX_USERS);
  const grants = (lost) => {
    if (lost[0] === '%All') return 'every resource (the %All role)';
    const c = capList(lost, MAX_GRANTS);
    return c.more ? `${c.shown.join(', ')} and ${c.more} more` : c.shown.join(', ');
  };
  const body = shown.length ? [
    h('p', h('strong', 'Enabled users who lose access:')),
    h('ul.access-losers', shown.map((u) => h('li', h('strong', u.Name), `: ${grants(u.lost)}`))),
    more ? h('p.muted', `and ${more} more`) : null,
  ] : h('p.muted', 'No enabled user loses access.');
  return { body: [body, h('p.muted.small', 'Counted from direct roles, roles granted through other roles and public permissions. Escalation roles are not counted.')], refuse };
};
