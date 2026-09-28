import { admin } from '../api.js';
import { can, session } from '../app.js';
import {
  h,
  page,
  table,
  load,
  modal,
  confirmAction,
  applyVerified,
  objectForm,
  diff,
  kv,
  badge,
  toast,
  toastError,
  apiCallPreview,
  button,
  toolbar,
  clear,
  icon,
} from '../ui.js';
import { accessCheck } from '../impact.js';

const path = (name) => `/api/admin/v2/security/user?name=${encodeURIComponent(name)}`;
const readUser = (name) => admin.get('/v2/security/user', { name });
const FIELDS = [
  { key: 'FullName', label: 'Full name' },
  { key: 'EmailAddress', label: 'Email' },
  { key: 'Enabled', type: 'bool' },
  { key: 'Comment', type: 'textarea' },
  { key: 'NameSpace', label: 'Terminal namespace' },
  { key: 'AccountNeverExpires', type: 'bool' },
  { key: 'PasswordNeverExpires', type: 'bool' },
  { key: 'ChangePassword', label: 'Change password on next login', type: 'bool' },
  { key: 'ExpirationDate', label: 'Account expiration date' },
];
// Passwords are redacted by the API client before they reach the API console.
const privatePost = (pathname, body, name) => admin.post(pathname, body, { name });
export default async function render(el, params) {
  const body = h('div');
  el.append(page('Users', null, body));
  const reload = () =>
    load(
      body,
      () => admin.get('/v2/security/users'),
      (rows) => [
        toolbar(
          can('Secure') ? button([icon('plus'), 'New user'], () => edit(null, reload), 'primary') : null,
          button('Refresh', reload),
        ),
        table(
          [
            { key: 'Name', label: 'Username' },
            { key: 'FullName', label: 'Full name' },
            {
              key: 'Enabled',
              label: 'State',
              render: (u) => badge(u.Enabled ? 'Enabled' : 'Disabled', u.Enabled ? 'ok' : 'muted'),
            },
            { key: 'Type', label: 'Type' },
            { key: 'Namespace', label: 'Namespace' },
          ],
          rows,
          { sortKey: 'Name', onRow: (u) => details(u.Name, reload), empty: 'No users found.' },
        ),
      ],
    );
  await reload();
  if (params?.[0]) details(params[0], reload);
}
async function details(name, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(name, body, { wide: true });
  try {
    const u = await readUser(name);
    // Never let the signed-in user disable or delete their own account from here.
    const self = session.info && String(session.info.username).toLowerCase() === String(name).toLowerCase();
    clear(
      body,
      self ? h('p.muted.small', 'This is your account: disabling or deleting it is blocked here.') : null,
      toolbar(
        can('Secure')
          ? button('Edit', () => {
              m.close();
              edit({ ...u, Name: name }, reload);
            })
          : null,
        can('Secure') && !(self && u.Enabled)
          ? button(u.Enabled ? 'Disable' : 'Enable', () =>
              confirmAction({
                title: `${u.Enabled ? 'Disable' : 'Enable'} ${name}`,
                message: u.Enabled
                  ? 'This user will no longer be able to sign in.'
                  : 'This user will be able to sign in again.',
                call: { method: 'PUT', path: path(name), body: { Enabled: !u.Enabled } },
                danger: u.Enabled,
                run: () => admin.put('/v2/security/user', { Enabled: !u.Enabled }, { name }),
                done: 'User updated',
                check: u.Enabled
                  ? accessCheck({ kind: 'updateUser', user: name, Enabled: false }, { list: false })
                  : null,
                verify: { read: () => readUser(name), changes: { Enabled: !u.Enabled } },
              }).then((ok) => {
                if (ok) {
                  m.close();
                  reload();
                }
              }),
            )
          : null,
        can('Secure') ? button('Change password', () => password(name)) : null,
        can('Secure')
          ? h(
              'button.danger',
              {
                disabled: self || /^(_SYSTEM|SuperUser|Admin)$/i.test(name),
                title: self
                  ? 'You cannot delete your own account'
                  : 'Protected administrator accounts cannot be deleted here',
                onclick: () =>
                  confirmAction({
                    title: `Delete ${name}`,
                    message: 'This permanently deletes the user account and its direct role assignments.',
                    call: { method: 'DELETE', path: path(name) },
                    danger: true,
                    confirmLabel: 'Delete',
                    confirmText: name,
                    run: () => admin.del('/v2/security/user', { name }),
                    check: accessCheck({ kind: 'deleteUser', user: name }, { list: false }),
                    verify: { read: () => readUser(name), expect: 'gone' },
                    done: 'User deleted',
                  }).then((ok) => {
                    if (ok) {
                      m.close();
                      reload();
                    }
                  }),
              },
              'Delete',
            )
          : null,
      ),
      h('h3', 'Direct roles'),
      h(
        'div.toolbar',
        (u.Roles || []).map((role) => badge(role)),
      ),
      u.EscalationRoles?.length
        ? [
            h('h3', 'Escalation roles'),
            h(
              'div.toolbar',
              u.EscalationRoles.map((role) => badge(role, 'warn')),
            ),
          ]
        : null,
      h('h3', 'Account'),
      kv(u, { skip: ['Roles', 'EscalationRoles'] }),
    );
  } catch (e) {
    clear(body, h('div.error-box', e.message));
  }
}
async function edit(user, reload) {
  const fresh = !user;
  const nameInput = fresh ? h('input', { required: true, placeholder: 'Username' }) : null;
  const passwordInput = fresh ? h('input', { type: 'password', autocomplete: 'new-password', required: true }) : null;
  const initial = user || {
    FullName: '',
    EmailAddress: '',
    Enabled: true,
    Comment: '',
    NameSpace: 'USER',
    AccountNeverExpires: true,
    PasswordNeverExpires: false,
    ChangePassword: true,
    ExpirationDate: '',
    Roles: [],
  };
  const form = objectForm(initial, FIELDS);
  const body = h('div', h('div.loading', 'Loading roles…'));
  const preview = h('div');
  const m = modal(fresh ? 'New user' : `Edit ${user.Name}`, body, { wide: true });
  try {
    const roles = await admin.get('/v2/security/roles');
    const choices = roles.map((r) => [
      r.Name,
      h('input', { type: 'checkbox', checked: initial.Roles?.includes(r.Name) || false }),
    ]);
    const build = () => {
      const name = fresh ? nameInput.value.trim() : user.Name;
      if (!name) throw new Error('Username is required.');
      const fields = form.value();
      fields.Roles = choices.filter(([, input]) => input.checked).map(([role]) => role);
      // Same guard as the Disable button: the signed-in account cannot switch itself off.
      if (
        !fresh &&
        fields.Enabled === false &&
        session.info &&
        String(session.info.username).toLowerCase() === String(name).toLowerCase()
      ) {
        throw new Error('You cannot disable your own account.');
      }
      const payload = fresh ? { User: fields, Password: passwordInput.value } : diff(user, fields);
      if (fresh && !passwordInput.value) throw new Error('Password is required.');
      return { name, payload };
    };
    const masked = (c) => (fresh ? { ...c.payload, Password: '***' } : c.payload);
    clear(
      body,
      fresh
        ? [h('div.field', h('label', 'Username'), nameInput), h('div.field', h('label', 'Password'), passwordInput)]
        : null,
      form.el,
      h('h3', 'Direct roles'),
      h(
        'div.form-grid',
        choices.map(([role, input]) => h('label.field.check', input, ` ${role}`)),
      ),
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              const c = build();
              clear(preview, apiCallPreview(fresh ? 'POST' : 'PUT', path(c.name), masked(c)));
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
      ),
      preview,
    );
    m.el.querySelector('.modal').append(
      h(
        'footer',
        button('Cancel', () => m.close()),
        button(
          fresh ? 'Create user' : 'Save changes',
          async () => {
            try {
              const c = build();
              if (!fresh && !Object.keys(c.payload).length) {
                toast('No changes', 'warn');
                return;
              }
              const write = () =>
                fresh
                  ? privatePost('/v2/security/user', c.payload, c.name)
                  : admin.put('/v2/security/user', c.payload, { name: c.name });
              const removed =
                !fresh && c.payload.Roles ? (user.Roles || []).filter((r) => !c.payload.Roles.includes(r)) : [];
              const disabling = !fresh && c.payload.Enabled === false;
              // Removing roles or disabling first shows who loses what and refuses to leave no %All holder.
              if (removed.length || disabling) {
                const ok = await confirmAction({
                  title: `Save ${c.name}`,
                  message: [
                    disabling ? 'This user will no longer be able to sign in.' : null,
                    removed.length ? `Roles removed: ${removed.join(', ')}.` : null,
                  ]
                    .filter(Boolean)
                    .join(' '),
                  call: { method: 'PUT', path: path(c.name), body: c.payload },
                  danger: true,
                  confirmLabel: 'Save changes',
                  check: accessCheck({ kind: 'updateUser', user: c.name, ...c.payload }, { list: removed.length > 0 }),
                  run: write,
                  verify: { original: user, changes: c.payload, read: () => readUser(c.name) },
                  done: 'User saved',
                });
                if (!ok) return;
              } else {
                await applyVerified(
                  {
                    ...(!fresh ? { original: user, changes: c.payload } : { expect: 'exists' }),
                    read: () => readUser(c.name),
                    write,
                  },
                  fresh ? 'User created' : 'User saved',
                );
              }
              m.close();
              reload();
            } catch (e) {
              toastError(e);
            }
          },
          'primary',
        ),
      ),
    );
  } catch (e) {
    clear(body, h('div.error-box', e.message));
  }
}
function password(name) {
  const input = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const preview = h('div');
  modal(
    `Change password for ${name}`,
    [
      h('p', 'The new password is sent to IRIS and is hidden from the API preview.'),
      h('div.field', h('label', 'New password'), input),
      toolbar(
        button(
          'Preview API call',
          () =>
            clear(
              preview,
              apiCallPreview('POST', `/api/admin/v2/security/user/password?name=${encodeURIComponent(name)}`, {
                NewPassword: '***',
              }),
            ),
          'small',
        ),
      ),
      preview,
    ],
    {
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: 'Change password',
          kind: 'primary',
          onclick: async () => {
            if (!input.value) throw new Error('Password is required.');
            await applyVerified(
              {
                read: () => readUser(name),
                write: () => privatePost('/v2/security/user/password', { NewPassword: input.value }, name),
              },
              'Password changed',
            );
          },
        },
      ],
    },
  );
}
