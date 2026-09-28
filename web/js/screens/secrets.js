import { admin, findInList } from '../api.js';
import { can } from '../app.js';
import {
  h,
  page,
  table,
  tabs,
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

const url = (base, key, value) => `/api/admin${base}?${key}=${encodeURIComponent(value)}`;
// Secret values are redacted by the API client before they reach the API console.
const privatePut = (path, name, body) => admin.put(path, body, { name });
const readCollection = (name) => admin.get('/v2/wallet/collection', { name });
const readCredential = (alias) => admin.get('/v2/security/x509-credential', { alias });
const readSsl = (name) => admin.get('/v2/security/ssl-configuration', { name });
const readServerDefinition = (serverId) => admin.get('/v2/security/oauth2/client/server-definition', { serverId });
const readClient = (applicationName) =>
  admin.get('/v2/security/oauth2/client/client-configuration', { applicationName });
const readResourceServer = (name) => admin.get('/v2/security/oauth2/resource-server', { name });
const readSecret = (collection, name) => findInList('/v2/wallet/secrets', { collection }, 'Name', name);
export default async function render(el, params) {
  // #/secrets/<tab> opens a tab; #/secrets/x509/<alias> also opens that credential (e.g. from the dashboard).
  let openAlias = params?.[0] === 'x509' ? params[1] : null;
  el.append(
    page(
      'Secrets & certificates',
      null,
      tabs(
        [
          { id: 'wallet', label: 'Wallet', render: walletTab },
          {
            id: 'x509',
            label: 'X.509 credentials',
            render: (b) => {
              x509Tab(b, openAlias);
              openAlias = null;
            },
          },
          { id: 'ssl', label: 'SSL/TLS', render: sslTab },
          { id: 'oauth', label: 'OAuth2', render: oauthTab },
        ],
        params?.[0],
      ),
    ),
  );
}
function walletTab(body) {
  const reload = () =>
    load(
      body,
      () => admin.get('/v2/wallet/collections'),
      (rows) => [
        toolbar(
          can('Wallet') ? button([icon('plus'), 'New collection'], () => collectionCreate(reload), 'primary') : null,
          button('Refresh', reload),
        ),
        table(
          [
            { key: 'Name', label: 'Collection' },
            { key: 'EditResource', label: 'Edit resource' },
            { key: 'UseResource', label: 'Use resource' },
          ],
          rows,
          { sortKey: 'Name', onRow: (r) => collectionDetails(r, reload), empty: 'No wallet collections.' },
        ),
      ],
    );
  reload();
}
function collectionCreate(reload) {
  const name = h('input', { required: true });
  const form = objectForm({ EditResource: '%Admin_Wallet:U', UseResource: '%Admin_Wallet:U' }, [
    { key: 'EditResource', required: true },
    { key: 'UseResource', required: true },
  ]);
  const preview = h('div');
  const build = () => {
    const n = name.value.trim();
    if (!n) throw new Error('Collection name is required.');
    return { name: n, body: form.value() };
  };
  modal(
    'New wallet collection',
    [
      h('div.field', h('label', 'Name'), name),
      form.el,
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              const c = build();
              clear(preview, apiCallPreview('PUT', url('/v2/wallet/collection', 'name', c.name), c.body));
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
      ),
      preview,
    ],
    {
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: 'Create',
          kind: 'primary',
          onclick: async () => {
            const c = build();
            await applyVerified(
              {
                write: () => admin.put('/v2/wallet/collection', c.body, { name: c.name }),
                read: () => readCollection(c.name),
                expect: 'exists',
              },
              'Collection created',
            );
            reload();
          },
        },
      ],
    },
  );
}
async function collectionDetails(row, reload) {
  const body = h('div');
  const m = modal(row.Name, body, { wide: true });
  const refresh = () =>
    load(
      body,
      () => admin.get('/v2/wallet/secrets', { collection: row.Name }),
      (secrets) => [
        toolbar(
          can('Wallet')
            ? button([icon('plus'), 'Add secret'], () => secretEdit(row.Name, null, refresh), 'primary')
            : null,
          can('Wallet')
            ? button(
                'Delete collection',
                () =>
                  confirmAction({
                    title: `Delete collection ${row.Name}`,
                    message: 'The collection must be empty. This removes its access settings.',
                    call: { method: 'DELETE', path: url('/v2/wallet/collection', 'name', row.Name) },
                    danger: true,
                    confirmLabel: 'Delete',
                    confirmText: row.Name,
                    run: () => admin.del('/v2/wallet/collection', { name: row.Name }),
                    verify: { read: () => readCollection(row.Name), expect: 'gone' },
                    done: 'Collection deleted',
                  }).then((ok) => {
                    if (ok) {
                      m.close();
                      reload();
                    }
                  }),
                'danger',
              )
            : null,
        ),
        h('p.muted', 'Secret values are never retrieved or displayed.'),
        table(
          [
            { key: 'Name', label: 'Secret' },
            { key: 'Type', label: 'Type' },
          ],
          secrets,
          {
            empty: 'No secrets in this collection.',
            actions: can('Wallet')
              ? (r) => [
                  button('Update', () => secretEdit(row.Name, r, refresh), 'small'),
                  button(
                    'Delete',
                    () =>
                      confirmAction({
                        title: `Delete secret ${r.Name}`,
                        message: 'The secret value will be permanently removed.',
                        call: { method: 'DELETE', path: url('/v2/wallet/secret', 'name', r.Name) },
                        danger: true,
                        confirmLabel: 'Delete',
                        confirmText: r.Name,
                        run: () => admin.del('/v2/wallet/secret', { name: r.Name }),
                        verify: { read: () => readSecret(row.Name, r.Name), expect: 'gone' },
                        done: 'Secret deleted',
                      }).then((ok) => ok && refresh()),
                    'danger',
                  ),
                ]
              : null,
          },
        ),
      ],
    );
  await refresh();
}
function secretEdit(collection, secret, reload) {
  const fresh = !secret;
  // Secret names are qualified by their collection: "<collection>.<secret>"
  const name = fresh
    ? h('input', {
        required: true,
        placeholder: 'secret-name',
        'aria-label': `Secret name (stored as ${collection}.<name>)`,
      })
    : null;
  const type = h(
    'select',
    ['%Wallet.KeyValue', '%Wallet.SymmetricKey', '%Wallet.RSA'].map((v) =>
      h('option', { value: v, selected: v === (secret?.Type || '%Wallet.KeyValue') }, v),
    ),
  );
  const value = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const config = h('textarea.mono', { rows: 4 }, '{}');
  const preview = h('div');
  const build = () => {
    const typed = fresh ? name.value.trim() : '';
    const n = fresh ? (typed.startsWith(`${collection}.`) ? typed : `${collection}.${typed}`) : secret.Name;
    if (fresh && !typed) throw new Error('Secret name is required.');
    if (!n || !value.value) throw new Error('Secret name and value are required.');
    let extra;
    try {
      extra = JSON.parse(config.value || '{}');
    } catch {
      throw new Error('Configuration must be valid JSON.');
    }
    if (!extra || Array.isArray(extra) || typeof extra !== 'object')
      throw new Error('Configuration must be an object.');
    // A JSON object value (e.g. {"user": "...", "password": "..."}) is stored as a structured secret.
    let secretValue = value.value;
    if (/^\s*\{/.test(secretValue)) {
      try {
        secretValue = JSON.parse(secretValue);
      } catch {
        throw new Error('Secret value looks like JSON but is not valid.');
      }
    }
    return { name: n, body: { Type: type.value, WalletSecretConfig: { ...extra, Secret: secretValue } } };
  };
  modal(
    fresh ? 'Add wallet secret' : `Update ${secret.Name}`,
    [
      fresh ? h('div.field', h('label', 'Name'), name, h('small.muted', `Stored as ${collection}.<name>`)) : null,
      h('div.field', h('label', 'Type'), type),
      h('div.field', h('label', 'Secret value'), value),
      h('div.field', h('label', 'Additional configuration (JSON)'), config),
      h(
        'p.muted',
        'The value is write-only. Updating it replaces the stored value. Enter a JSON object (e.g. {"user": "…", "password": "…"}) to store a structured secret.',
      ),
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              const c = build();
              clear(
                preview,
                apiCallPreview('PUT', url('/v2/wallet/secret', 'name', c.name), {
                  ...c.body,
                  WalletSecretConfig: { ...c.body.WalletSecretConfig, Secret: '***' },
                }),
              );
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
      ),
      preview,
    ],
    {
      wide: true,
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: fresh ? 'Add secret' : 'Update secret',
          kind: 'primary',
          onclick: async () => {
            const c = build();
            await applyVerified(
              {
                ...(!fresh ? { original: secret, changes: diff(secret, { Type: c.body.Type }) } : { expect: 'exists' }),
                read: () => readSecret(collection, c.name),
                write: () => privatePut('/v2/wallet/secret', c.name, c.body),
              },
              fresh ? 'Secret added' : 'Secret updated',
            );
            reload();
          },
        },
      ],
    },
  );
}
function x509Tab(body, openAlias) {
  const reload = () =>
    load(
      body,
      async () => {
        const rows = await admin.get('/v2/security/x509-credentials');
        return Promise.all(
          rows.map(async (row) => {
            try {
              const certificate = await admin.get('/v2/security/x509-credential/certificate', { alias: row.Alias });
              return { ...row, ValidityNotAfter: certificate.ValidityNotAfter };
            } catch {
              return row;
            }
          }),
        );
      },
      (rows) => [
        toolbar(
          can('Secure') ? button([icon('plus'), 'New credential'], () => credentialCreate(reload), 'primary') : null,
          button('Refresh', reload),
        ),
        table(
          [
            { key: 'Alias', label: 'Alias' },
            {
              key: 'HasPrivateKey',
              label: 'Private key',
              render: (r) => (r.HasPrivateKey ? badge('Yes', 'ok') : 'No'),
            },
            { key: 'OwnerList', label: 'Owners' },
            { key: 'ValidityNotAfter', label: 'Expiry', render: (r) => expiry(r.ValidityNotAfter) },
          ],
          rows,
          { sortKey: 'Alias', onRow: (r) => credentialDetails(r.Alias, reload), empty: 'No X.509 credentials.' },
        ),
      ],
    );
  reload().then(() => {
    if (openAlias) credentialDetails(openAlias, reload);
  });
}
function expiry(raw) {
  if (!raw) return 'See certificate';
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return raw;
  const days = (time - Date.now()) / 86400000;
  return h(
    'span',
    raw,
    ' ',
    days < 0 ? badge('Expired', 'err') : days < 30 ? badge('Expiring soon', 'warn') : badge('Valid', 'ok'),
  );
}
async function credentialDetails(alias, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(alias, body, { wide: true });
  try {
    const [credential, certificate] = await Promise.all([
      admin.get('/v2/security/x509-credential', { alias }),
      admin.get('/v2/security/x509-credential/certificate', { alias }),
    ]);
    clear(
      body,
      toolbar(
        can('Secure')
          ? button(
              'Delete',
              () =>
                confirmAction({
                  title: `Delete credential ${alias}`,
                  message: 'This removes the stored credential and may break TLS connections using it.',
                  call: { method: 'DELETE', path: url('/v2/security/x509-credential', 'alias', alias) },
                  danger: true,
                  confirmLabel: 'Delete',
                  confirmText: alias,
                  run: () => admin.del('/v2/security/x509-credential', { alias }),
                  verify: { read: () => readCredential(alias), expect: 'gone' },
                  done: 'Credential deleted',
                }).then((ok) => {
                  if (ok) {
                    m.close();
                    reload();
                  }
                }),
              'danger',
            )
          : null,
      ),
      h('h3', 'Certificate'),
      expiry(certificate.ValidityNotAfter),
      kv(certificate),
      h('h3', 'Credential'),
      kv(credential),
    );
  } catch (e) {
    clear(body, h('div.error-box', e.message));
  }
}
function credentialCreate(reload) {
  const alias = h('input', { required: true });
  const form = objectForm({ OwnerList: [], CAFile: '', PeerNames: [], CertificateFile: '', PrivateKeyFile: '' }, [
    { key: 'OwnerList', type: 'json' },
    { key: 'CAFile' },
    { key: 'PeerNames', type: 'json' },
    { key: 'CertificateFile', required: true },
    { key: 'PrivateKeyFile' },
  ]);
  const password = h('input', { type: 'password', autocomplete: 'new-password' });
  const preview = h('div');
  const build = () => {
    if (!alias.value.trim()) throw new Error('Alias is required.');
    return {
      alias: alias.value.trim(),
      body: {
        Alias: alias.value.trim(),
        ...form.value(),
        ...(password.value ? { PrivateKeyPassword: password.value } : {}),
      },
    };
  };
  modal(
    'New X.509 credential',
    [
      h('div.field', h('label', 'Alias'), alias),
      form.el,
      h('div.field', h('label', 'Private key password'), password),
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              const c = build();
              clear(
                preview,
                apiCallPreview('POST', url('/v2/security/x509-credential', 'alias', c.alias), {
                  ...c.body,
                  ...(c.body.PrivateKeyPassword ? { PrivateKeyPassword: '***' } : {}),
                }),
              );
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
      ),
      preview,
    ],
    {
      wide: true,
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: 'Create',
          kind: 'primary',
          onclick: async () => {
            const c = build();
            await applyVerified(
              {
                write: () => privatePostCredential(c.alias, c.body),
                read: () => readCredential(c.alias),
                expect: 'exists',
              },
              'Credential created',
            );
            reload();
          },
        },
      ],
    },
  );
}
const privatePostCredential = (alias, body) => admin.post('/v2/security/x509-credential', body, { alias });
function sslTab(body) {
  const reload = () =>
    load(
      body,
      () => admin.get('/v2/security/ssl-configurations'),
      (rows) => [
        toolbar(
          can('Secure')
            ? button([icon('plus'), 'New TLS configuration'], () => sslEdit(null, reload), 'primary')
            : null,
          button('Refresh', reload),
        ),
        table(
          [
            { key: 'Name', label: 'Configuration' },
            { key: 'Type', label: 'Type' },
            { key: 'Description', label: 'Description' },
            {
              key: 'Enabled',
              label: 'State',
              render: (r) => badge(r.Enabled ? 'Enabled' : 'Disabled', r.Enabled ? 'ok' : 'muted'),
            },
          ],
          rows,
          { sortKey: 'Name', onRow: (r) => sslDetails(r.Name, reload), empty: 'No TLS configurations.' },
        ),
      ],
    );
  reload();
}
async function sslDetails(name, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(name, body, { wide: true });
  try {
    const config = await readSsl(name);
    clear(
      body,
      toolbar(
        can('Secure')
          ? button('Edit', () => {
              m.close();
              sslEdit({ ...config, Name: name }, reload);
            })
          : null,
        can('Secure') ? button('Test', () => sslTest(name)) : null,
        can('Secure')
          ? button(
              'Delete',
              () =>
                confirmAction({
                  title: `Delete TLS configuration ${name}`,
                  message: 'Connections referencing this configuration may fail.',
                  call: { method: 'DELETE', path: url('/v2/security/ssl-configuration', 'name', name) },
                  danger: true,
                  confirmLabel: 'Delete',
                  confirmText: name,
                  run: () => admin.del('/v2/security/ssl-configuration', { name }),
                  verify: { read: () => readSsl(name), expect: 'gone' },
                  done: 'TLS configuration deleted',
                }).then((ok) => {
                  if (ok) {
                    m.close();
                    reload();
                  }
                }),
              'danger',
            )
          : null,
      ),
      kv(config),
    );
  } catch (e) {
    clear(body, h('div.error-box', e.message));
  }
}
// TLS versions are a bitmask: 4 = TLS 1.0, 8 = TLS 1.1, 16 = TLS 1.2, 32 = TLS 1.3
const TLS_VERSIONS = [
  [4, 'TLS 1.0'],
  [8, 'TLS 1.1'],
  [16, 'TLS 1.2'],
  [32, 'TLS 1.3'],
];
function sslEdit(config, reload) {
  const fresh = !config;
  const initial = config || {
    Description: '',
    Enabled: true,
    Type: 0,
    CAFile: '',
    CertificateFile: '',
    PrivateKeyFile: '',
    VerifyPeer: 1,
    TLSMinVersion: 16,
    TLSMaxVersion: 32,
  };
  const name = fresh ? h('input', { required: true }) : null;
  const form = objectForm(initial, [
    { key: 'Description', type: 'textarea' },
    { key: 'Enabled', type: 'bool' },
    {
      key: 'Type',
      type: 'select',
      options: [
        [0, 'Client'],
        [1, 'Server'],
      ],
    },
    { key: 'CAFile' },
    { key: 'CAPath' },
    { key: 'CertificateFile' },
    { key: 'PrivateKeyFile' },
    {
      key: 'VerifyPeer',
      label: 'Verify peer',
      type: 'select',
      options: [
        [0, 'None'],
        [1, 'Require (client) / Request (server)'],
        [3, 'Require (server)'],
      ],
    },
    { key: 'TLSMinVersion', label: 'Minimum TLS version', type: 'select', options: TLS_VERSIONS },
    { key: 'TLSMaxVersion', label: 'Maximum TLS version', type: 'select', options: TLS_VERSIONS },
  ]);
  const numeric = (v) => {
    for (const k of ['Type', 'VerifyPeer', 'TLSMinVersion', 'TLSMaxVersion'])
      if (v[k] !== undefined && v[k] !== '') v[k] = Number(v[k]);
    return v;
  };
  const preview = h('div');
  const build = () => {
    const n = fresh ? name.value.trim() : config.Name;
    if (!n) throw new Error('Name is required.');
    const v = numeric(form.value());
    return { name: n, body: fresh ? v : diff(config, v) };
  };
  modal(
    fresh ? 'New TLS configuration' : `Edit ${config.Name}`,
    [
      fresh ? h('div.field', h('label', 'Name'), name) : null,
      form.el,
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              const c = build();
              clear(preview, apiCallPreview('PUT', url('/v2/security/ssl-configuration', 'name', c.name), c.body));
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
      ),
      preview,
    ],
    {
      wide: true,
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: fresh ? 'Create' : 'Save changes',
          kind: 'primary',
          onclick: async () => {
            const c = build();
            if (!Object.keys(c.body).length) {
              toast('No changes', 'warn');
              return false;
            }
            await applyVerified(
              {
                ...(!fresh ? { original: config, changes: c.body } : { expect: 'exists' }),
                read: () => readSsl(c.name),
                write: () => admin.put('/v2/security/ssl-configuration', c.body, { name: c.name }),
              },
              fresh ? 'TLS configuration created' : 'TLS configuration saved',
            );
            reload();
          },
        },
      ],
    },
  );
}
function sslTest(name) {
  const host = h('input', { placeholder: 'example.com' });
  const port = h('input', { type: 'number', value: 443 });
  const result = h('div');
  const preview = h('div');
  const build = () => {
    if (!host.value.trim() || !Number(port.value)) throw new Error('Host and port are required.');
    return { Host: host.value.trim(), Port: Number(port.value) };
  };
  modal(
    `Test ${name}`,
    [
      h('p.muted', 'Connect to a host using this TLS configuration.'),
      h('div.field', h('label', 'Host'), host),
      h('div.field', h('label', 'Port'), port),
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              clear(preview, apiCallPreview('POST', url('/v2/security/ssl-configuration/test', 'name', name), build()));
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
        button(
          'Run test',
          async () => {
            try {
              const data = await admin.post('/v2/security/ssl-configuration/test', build(), { name });
              clear(result, kv(data));
            } catch (e) {
              clear(result, h('div.error-box', e.message));
            }
          },
          'primary',
        ),
      ),
      preview,
      result,
    ],
    { wide: true },
  );
}
function oauthTab(body) {
  const authServer = h('div');
  const servers = h('div');
  const resources = h('div');
  clear(
    body,
    h('h3', 'This instance as an authorization server'),
    authServer,
    h('h3', 'Authorization server definitions'),
    toolbar(
      can('OAuth2_Client')
        ? button([icon('plus'), 'New server definition'], () => serverDefinitionCreate(() => oauthTab(body)), 'primary')
        : null,
    ),
    servers,
    h('h3', 'Resource servers'),
    resources,
  );
  loadAuthServer(authServer);
  load(
    servers,
    () => admin.get('/v2/security/oauth2/client/server-definitions'),
    (rows) =>
      table(
        [
          { key: 'ID', label: 'ID' },
          { key: 'IssuerEndpoint', label: 'Issuer endpoint' },
          { key: 'ClientCount', label: 'Clients' },
          { key: 'ResourceCount', label: 'Resources' },
        ],
        rows,
        { onRow: (r) => oauthServer(r.ID, () => oauthTab(body)), empty: 'No server definitions.' },
      ),
  );
  load(
    resources,
    () => admin.get('/v2/security/oauth2/resource-servers'),
    (rows) =>
      table(
        [
          { key: 'Name', label: 'Name' },
          { key: 'ServerDefinition', label: 'Server definition' },
        ],
        rows,
        { onRow: (r) => oauthResource(r.Name, () => oauthTab(body)), empty: 'No resource servers.' },
      ),
  );
}
// Read-only: whether this instance itself is configured as an OAuth2 authorization server.
async function loadAuthServer(box) {
  clear(box, h('div.loading', 'Loading…'));
  try {
    const config = await admin.get('/v2/security/oauth2/server');
    const clients = await admin.get('/v2/security/oauth2/server/clients').catch(() => []);
    clear(
      box,
      h('h4', 'Server configuration'),
      kv(config),
      h('h4', 'Registered clients'),
      table(
        [
          { key: 'ClientId', label: 'Client ID' },
          { key: 'ClientName', label: 'Name' },
        ],
        clients,
        { empty: 'No registered clients.' },
      ),
    );
  } catch (e) {
    // IRIS returns error #8864 when the instance has no authorization-server configuration at all.
    if (/8864|not configured/i.test(e.message))
      clear(box, h('p.muted', 'This instance is not configured as an OAuth2 authorization server.'));
    else clear(box, h('div.error-box', e.message));
  }
}
async function oauthServer(serverId, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(`OAuth2 server ${serverId}`, body, { wide: true });
  const refresh = () => oauthServer(serverId, reload);
  try {
    const [detail, clients] = await Promise.all([
      readServerDefinition(serverId),
      admin.get('/v2/security/oauth2/client/client-configurations', { serverId }),
    ]);
    clear(
      body,
      toolbar(
        can('OAuth2_Client')
          ? button([icon('plus'), 'New client configuration'], () => clientConfigCreate(serverId, refresh), 'primary')
          : null,
        can('OAuth2_Client')
          ? button(
              'Delete',
              () =>
                confirmAction({
                  title: `Delete server definition ${serverId}`,
                  message: 'OAuth2 clients using this definition may stop working.',
                  call: {
                    method: 'DELETE',
                    path: url('/v2/security/oauth2/client/server-definition', 'serverId', serverId),
                  },
                  danger: true,
                  confirmLabel: 'Delete',
                  confirmText: String(serverId),
                  run: () => admin.del('/v2/security/oauth2/client/server-definition', { serverId }),
                  verify: { read: () => readServerDefinition(serverId), expect: 'gone' },
                  done: 'Definition deleted',
                }).then((ok) => {
                  if (ok) {
                    m.close();
                    reload();
                  }
                }),
              'danger',
            )
          : null,
      ),
      h('h3', 'Client configurations'),
      table(
        [
          { key: 'ApplicationName', label: 'Application' },
          { key: 'ClientType', label: 'Type' },
          { key: 'DefaultScope', label: 'Scope' },
        ],
        clients,
        { onRow: (r) => oauthClient(r.ApplicationName, refresh), empty: 'No clients.' },
      ),
      h('h3', 'Definition'),
      kv(detail),
    );
  } catch (e) {
    clear(body, h('div.error-box', e.message));
  }
}
async function oauthClient(applicationName, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(applicationName, body, { wide: true });
  try {
    const detail = await readClient(applicationName);
    clear(
      body,
      toolbar(
        can('OAuth2_Client')
          ? button('Edit', () => {
              m.close();
              clientConfigEdit(applicationName, detail, reload);
            })
          : null,
        can('OAuth2_Client')
          ? button(
              'Delete',
              () =>
                confirmAction({
                  title: `Delete OAuth2 client ${applicationName}`,
                  message: 'This client will no longer be able to use OAuth2.',
                  call: {
                    method: 'DELETE',
                    path: url('/v2/security/oauth2/client/client-configuration', 'applicationName', applicationName),
                  },
                  danger: true,
                  confirmLabel: 'Delete',
                  confirmText: applicationName,
                  run: () => admin.del('/v2/security/oauth2/client/client-configuration', { applicationName }),
                  verify: { read: () => readClient(applicationName), expect: 'gone' },
                  done: 'Client deleted',
                }).then((ok) => {
                  if (ok) {
                    m.close();
                    reload();
                  }
                }),
              'danger',
            )
          : null,
      ),
      kv(detail),
    );
  } catch (e) {
    clear(body, h('div.error-box', e.message));
  }
}
// ---------- OAuth2 server definitions ----------
function serverDefinitionCreate(reload) {
  const issuer = h('input', { required: true, placeholder: 'https://issuer.example.com' });
  const ssl = h('input', { required: true, placeholder: 'ISC.FeatureTracker.SSL.Config' });
  const discover = h('input', { type: 'checkbox' });
  const extra = h('textarea.mono', { rows: 6 }, '{}');
  const preview = h('div');
  const build = () => {
    const IssuerEndpoint = issuer.value.trim();
    if (!IssuerEndpoint) throw new Error('Issuer endpoint is required.');
    if (!ssl.value.trim()) throw new Error('SSL/TLS configuration is required.');
    let more;
    try {
      more = JSON.parse(extra.value || '{}');
    } catch {
      throw new Error('Additional fields must be valid JSON.');
    }
    if (!more || Array.isArray(more) || typeof more !== 'object')
      throw new Error('Additional fields must be a JSON object.');
    const body = { IssuerEndpoint, SSLConfiguration: ssl.value.trim(), ...more };
    return { body, query: discover.checked ? { discover: 1 } : {} };
  };
  modal(
    'New server definition',
    [
      h('div.field', h('label', 'Issuer endpoint'), issuer),
      h(
        'div.field',
        h('label', 'SSL/TLS configuration'),
        ssl,
        h(
          'small.muted',
          'Used for discovery requests to this authorization server, e.g. ISC.FeatureTracker.SSL.Config.',
        ),
      ),
      h(
        'div.field.check',
        h('label', { for: 'oauth-discover' }, 'Discover endpoints from the issuer'),
        Object.assign(discover, { id: 'oauth-discover' }),
        h(
          'small.muted',
          'IRIS will fetch the issuer’s well-known document over the network. Leave off and supply Metadata.authorization_endpoint / token_endpoint below when the authorization server is not reachable.',
        ),
      ),
      h('div.field.span', h('label', 'Additional fields (JSON, e.g. Metadata, ServerCredentials)'), extra),
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              const c = build();
              const path = `/api/admin/v2/security/oauth2/client/server-definition${c.query.discover ? '?discover=1' : ''}`;
              clear(preview, apiCallPreview('POST', path, c.body));
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
      ),
      preview,
    ],
    {
      wide: true,
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: 'Create',
          kind: 'primary',
          onclick: async () => {
            const c = build();
            // Surfaced as-is: discovery failures (unreachable issuer) are a real server error, not something to hide.
            await applyVerified(
              {
                write: () => admin.post('/v2/security/oauth2/client/server-definition', c.body, c.query),
                read: () =>
                  findInList(
                    '/v2/security/oauth2/client/server-definitions',
                    {},
                    'IssuerEndpoint',
                    c.body.IssuerEndpoint,
                  ),
                expect: 'exists',
              },
              'Server definition created',
            );
            reload();
          },
        },
      ],
    },
  );
}
// ---------- OAuth2 client configurations ----------
const CLIENT_TYPES = ['public', 'confidential', 'resource'];
function clientConfigFields(serverId) {
  return [
    { key: 'ServerDefinition', label: 'Server definition', required: true },
    { key: 'ClientType', type: 'select', options: CLIENT_TYPES },
    { key: 'Enabled', type: 'bool' },
    { key: 'Description', type: 'textarea' },
    { key: 'SSLConfiguration', label: 'SSL/TLS configuration' },
    { key: 'RedirectionEndpoint', label: 'Redirection endpoint' },
    { key: 'DefaultScope', label: 'Default scope', help: 'Blank separated, e.g. "openid profile"' },
    { key: 'JWTAudience', label: 'JWT audience' },
    { key: 'ClientCredentials', label: 'Client credentials (X.509 alias)' },
    { key: 'ClientId', label: 'Client ID' },
    { key: 'ClientSecret', label: 'Client secret', type: 'password' },
    { key: 'ClientPassword', label: 'Client private key password', type: 'password' },
    { key: 'Metadata', type: 'json' },
  ];
}
function clientConfigCreate(serverId, reload) {
  const appName = h('input', { required: true });
  const initial = { ServerDefinition: String(serverId), ClientType: 'confidential', Enabled: true };
  const form = objectForm(initial, clientConfigFields(serverId));
  const preview = h('div');
  const build = () => {
    const name = appName.value.trim();
    if (!name) throw new Error('Application name is required.');
    return { name, body: form.value() };
  };
  modal(
    'New client configuration',
    [
      h('div.field', h('label', 'Application name'), appName),
      form.el,
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              const c = build();
              clear(
                preview,
                apiCallPreview(
                  'PUT',
                  url('/v2/security/oauth2/client/client-configuration', 'applicationName', c.name),
                  c.body,
                ),
              );
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
      ),
      preview,
    ],
    {
      wide: true,
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: 'Create',
          kind: 'primary',
          onclick: async () => {
            const c = build();
            await applyVerified(
              {
                write: () =>
                  admin.put('/v2/security/oauth2/client/client-configuration', c.body, { applicationName: c.name }),
                read: () => readClient(c.name),
                expect: 'exists',
              },
              'Client configuration created',
            );
            reload();
          },
        },
      ],
    },
  );
}
function clientConfigEdit(applicationName, current, reload) {
  const form = objectForm(current, clientConfigFields(current.ServerDefinition));
  const preview = h('div');
  const build = () => diff(current, form.value());
  modal(
    `Edit ${applicationName}`,
    [
      form.el,
      toolbar(
        button(
          'Preview API call',
          () => {
            try {
              clear(
                preview,
                apiCallPreview(
                  'PUT',
                  url('/v2/security/oauth2/client/client-configuration', 'applicationName', applicationName),
                  build(),
                ),
              );
            } catch (e) {
              toastError(e);
            }
          },
          'small',
        ),
      ),
      preview,
    ],
    {
      wide: true,
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: 'Save changes',
          kind: 'primary',
          onclick: async () => {
            const payload = build();
            if (!Object.keys(payload).length) {
              toast('No changes', 'warn');
              return false;
            }
            await applyVerified(
              {
                original: current,
                changes: payload,
                read: () => readClient(applicationName),
                write: () => admin.put('/v2/security/oauth2/client/client-configuration', payload, { applicationName }),
              },
              'Client configuration saved',
            );
            reload();
          },
        },
      ],
    },
  );
}
async function oauthResource(name, reload) {
  const body = h('div', h('div.loading', 'Loading…'));
  const m = modal(name, body, { wide: true });
  try {
    const detail = await readResourceServer(name);
    clear(
      body,
      toolbar(
        can('Secure')
          ? button(
              'Delete',
              () =>
                confirmAction({
                  title: `Delete resource server ${name}`,
                  message: 'OAuth2 protection for services referencing it may fail.',
                  call: { method: 'DELETE', path: url('/v2/security/oauth2/resource-server', 'name', name) },
                  danger: true,
                  confirmLabel: 'Delete',
                  confirmText: name,
                  run: () => admin.del('/v2/security/oauth2/resource-server', { name }),
                  verify: { read: () => readResourceServer(name), expect: 'gone' },
                  done: 'Resource server deleted',
                }).then((ok) => {
                  if (ok) {
                    m.close();
                    reload();
                  }
                }),
              'danger',
            )
          : null,
      ),
      kv(detail),
    );
  } catch (e) {
    clear(body, h('div.error-box', e.message));
  }
}
