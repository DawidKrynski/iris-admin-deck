import { jobsIndicator } from './jobs-ui.js';
// App shell: login, navigation, hash router, API console drawer.
import { admin, ext, login, logout, onCall, curl } from './api.js';
import { h, clear, toastError, copy, errorBox, loading, icon, closeModals } from './ui.js';
import { installPalette, openPalette, resetPalette, closePalette } from './palette.js';
import { versionLabel as serverLabel } from './iris.js';

// `priv` = SysAdmin API privilege(s) (from /api/admin/info) needed for the screen; any of them suffices.
export const NAV = [
  { group: 'Overview', items: [
    { path: 'dashboard', label: 'Dashboard', priv: ['Operate'], module: './screens/dashboard.js' },
  ] },
  { group: 'Applications', items: [
    { path: 'webapps', label: 'Web apps & REST', priv: ['Secure'], module: './screens/webapps.js' },
    { path: 'explorer', label: 'API explorer', module: './screens/explorer.js' },
  ] },
  { group: 'Security', items: [
    { path: 'users', label: 'Users', priv: ['Secure'], module: './screens/users.js' },
    { path: 'roles', label: 'Roles & permissions', priv: ['Secure'], module: './screens/roles.js' },
    { path: 'secrets', label: 'Secrets & certificates', priv: ['Secure', 'Wallet', 'OAuth2_Client'], module: './screens/secrets.js' },
  ] },
  { group: 'System operation', items: [
    { path: 'tasks', label: 'Tasks', priv: ['Operate', 'Task'], module: './screens/tasks.js' },
    { path: 'processes', label: 'Processes & locks', priv: ['Operate'], module: './screens/processes.js' },
    { path: 'system', label: 'Databases & system', priv: ['Manage', 'Operate'], module: './screens/system.js' },
    { path: 'languages', label: 'Language servers', priv: ['ExternalLanguageServerEdit'], module: './screens/languages.js' },
    { path: 'interop', label: 'Interoperability', priv: ['Operate'], module: './screens/interop.js' },
  ] },
  { group: 'Monitoring', items: [
    { path: 'status', label: 'Status', priv: ['Operate'], module: './screens/status.js' },
    { path: 'logs', label: 'Logs & insights', priv: ['Operate'], module: './screens/logs.js' },
    { path: 'audit', label: 'Audit trail', priv: ['Secure'], module: './screens/audit.js' },
  ] },
];
const ROUTES = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.path, { ...i, group: g.group }])));

export const session = { info: null };

export function can(...privs) {
  const p = session.info && session.info.privileges;
  if (!p || !privs.length) return true;
  return privs.some((x) => p[x] && p[x].use);
}

export function navigate(path) { location.hash = `#/${path}`; }

const root = document.getElementById('app');
let main; let consoleList; let consolePanel; let navEl; let menuButton;
const calls = [];
const SIDEBAR_MODES = ['pinned', 'auto', 'hidden'];

function applyTheme(t) {
  try { if (t) localStorage.setItem('adminDeck.theme', t); } catch { /* ignore */ }
  let theme = t;
  try { theme = theme || localStorage.getItem('adminDeck.theme'); } catch { /* ignore */ }
  document.querySelector('[aria-label="Dark theme"]')?.setAttribute('aria-pressed', String(theme === 'dark'));
  if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
}

function applySidebar(mode) {
  try { if (mode) localStorage.setItem('adminDeck.sidebar', mode); } catch { /* ignore */ }
  let selected = mode;
  try { selected = selected || localStorage.getItem('adminDeck.sidebar'); } catch { /* ignore */ }
  if (!SIDEBAR_MODES.includes(selected)) selected = 'pinned';
  document.documentElement.dataset.sidebar = selected;
  if (menuButton) {
    const next = SIDEBAR_MODES[(SIDEBAR_MODES.indexOf(selected) + 1) % SIDEBAR_MODES.length];
    menuButton.title = `Sidebar: ${selected}. Click to ${{ auto: 'auto-hide', hidden: 'hide', pinned: 'pin' }[next]}`;
    menuButton.setAttribute('aria-label', menuButton.title);
    syncSidebar();
  }
}

function syncSidebar() {
  const mobile = matchMedia('(max-width: 860px)').matches;
  const mode = document.documentElement.dataset.sidebar;
  const expanded = mobile ? document.body.classList.contains('nav-open')
    : mode === 'pinned' || (mode === 'auto' && (navEl?.matches(':hover, :focus-within') || document.querySelector('.sidebar-edge:hover')));
  menuButton?.setAttribute('aria-expanded', String(!!expanded));
  if (mobile) menuButton?.setAttribute('aria-label', 'Toggle navigation');
  // Auto-hide remains keyboard reachable: focus-within reveals it before a link is used.
  if (navEl) navEl.inert = mobile ? !expanded : mode === 'hidden';
}
matchMedia('(max-width: 860px)').addEventListener('change', syncSidebar);
document.querySelector('.skip-link').addEventListener('click', (e) => {
  e.preventDefault(); document.getElementById('main')?.focus();
});

function cycleSidebar() {
  if (matchMedia('(max-width: 860px)').matches) { document.body.classList.toggle('nav-open'); syncSidebar(); return; }
  applySidebar(SIDEBAR_MODES[(SIDEBAR_MODES.indexOf(document.documentElement.dataset.sidebar) + 1) % SIDEBAR_MODES.length]);
}

function renderLogin(message) {
  // Nothing of the previous session may stay on screen: dialogs, palette, API call history.
  closePalette();
  closeModals();
  closeAccount();
  document.title = 'Sign in · IRIS Admin Deck';
  resetPalette();
  calls.length = 0;
  session.info = null;
  const user = h('input#login-user', { type: 'text', autocomplete: 'username', required: true, value: '' });
  const pass = h('input#login-pass', { type: 'password', autocomplete: 'current-password', required: true });
  const err = h('p.login-error', { role: 'alert' }, message || '');
  const btn = h('button.primary', { type: 'submit' }, 'Sign in');
  const form = h('form.login-card', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true; err.textContent = '';
      try {
        await login(user.value.trim(), pass.value);
        pass.value = '';
        await start();
      } catch (ex) {
        err.textContent = ex.status === 401 || ex.status === 403 ? 'Invalid user name or password.' : ex.message;
      } finally { btn.disabled = false; }
    },
  },
  h('div.brand.big', h('img', { src: 'img/logo.svg', alt: '' }), h('span', 'IRIS Admin Deck')),
  h('p.muted', 'InterSystems IRIS 2026.2+ · /api/admin/v2'),
  h('label', { for: 'login-user' }, 'User name'), user,
  h('label', { for: 'login-pass' }, 'Password'), pass,
  err, btn);
  clear(root, h('main#main.login-wrap', { tabindex: '-1' }, form));
  user.focus();
  // Optional deployment config (public demo): {"notice": "...", "username": "...", "password": "..."}
  fetch('config.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((cfg) => {
    if (!cfg) return;
    if (cfg.notice) err.before(h('p.idea-note.small', cfg.notice));
    if (cfg.username && !user.value) user.value = cfg.username;
    if (cfg.password && !pass.value) pass.value = cfg.password;
  }).catch(() => {});
}

function renderShell() {
  navEl = h('nav#navigation.sidebar', { 'aria-label': 'Main' },
    h('a.brand', { href: '#/dashboard' }, h('img', { src: 'img/logo.svg', alt: '' }), h('span', 'Admin Deck')),
    NAV.map((g) => {
      const items = g.items.filter((i) => !i.priv || can(...i.priv));
      if (!items.length) return null;
      return h('div.nav-group', h('div.nav-title', g.group),
        items.map((i) => h('a.nav-item', { href: `#/${i.path}`, dataset: { path: i.path },
          onclick: (e) => { if (document.documentElement.dataset.sidebar === 'auto') e.currentTarget.blur(); } },
        icon(i.path), h('span', i.label))));
    }),
    h('div.sidebar-foot', serverLabel((session.info || {}).serverVersion)));
  const info = session.info || {};
  consoleList = h('ol.console-list');
  consolePanel = h('aside.api-console', { hidden: true, 'aria-label': 'API console' },
    h('header', h('strong', 'API console'), h('span.muted', ' · last 200 requests from this tab'),
      h('button.small', { onclick: () => { calls.length = 0; drawConsole(); } }, 'Clear'),
      h('button.icon', { onclick: () => toggleConsole(false), 'aria-label': 'Close console' }, icon('close'))),
    consoleList);
  main = h('main#main', { tabindex: '-1' });
  menuButton = h('button.icon.menu', { onclick: cycleSidebar, 'aria-controls': 'navigation', 'aria-label': 'Toggle navigation' }, icon('menu'));
  const top = h('header.topbar',
    menuButton,
    h('div.spacer'),
    h('button.ghost.search-button', { onclick: () => openPalette(paletteSources()), title: 'Go to anything (Ctrl+K)' }, icon('search'), h('span', 'Search'), h('kbd', 'Ctrl K')),
    jobsIndicator(),
    h('button.ghost.console-button', { onclick: () => toggleConsole(), title: 'Show API calls made by this page' }, icon('console'), h('span', 'API console')),
    h('button.ghost', { onclick: cycleTheme, title: 'Toggle light / dark theme', 'aria-label': 'Dark theme', 'aria-pressed': document.documentElement.dataset.theme === 'dark' }, icon('theme')),
    h('button.ghost.account-button', { onclick: toggleAccount, 'aria-label': 'Account', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Account' },
      icon('users'), h('span.user', info.username || '')));
  clear(root, h('div.shell', h('div.sidebar-edge'), navEl, h('div.content', top, main, consolePanel)));
  for (const el of [navEl, root.querySelector('.sidebar-edge')]) {
    for (const event of ['mouseenter', 'mouseleave', 'focusin']) el.addEventListener(event, syncSidebar);
    el.addEventListener('focusout', () => queueMicrotask(syncSidebar));
  }
  applySidebar();
}

// ---------- account menu: who is signed in, with which rights, on which server ----------
let accountMenu = null;
function closeAccount() {
  if (!accountMenu) return;
  accountMenu.remove();
  accountMenu = null;
  document.removeEventListener('mousedown', onOutside);
  document.removeEventListener('keydown', onAccountKey);
  document.querySelector('.account-button')?.setAttribute('aria-expanded', 'false');
}
const onOutside = (e) => { if (!e.target.closest('.account-menu, .account-button')) closeAccount(); };
const onAccountKey = (e) => { if (e.key === 'Escape') { closeAccount(); document.querySelector('.account-button')?.focus(); } };

function toggleAccount() {
  if (accountMenu) return closeAccount();
  const info = session.info || {};
  const privileges = Object.entries(info.privileges || {}).filter(([, v]) => v && v.use).map(([k]) => k).sort();
  const roles = h('dd', '…');
  accountMenu = h('div.account-menu', { role: 'dialog', 'aria-labelledby': 'account-title' },
    h('div.account-head', h('strong#account-title', info.username || '—')),
    h('dl.kv',
      h('dt', 'Roles'), roles,
      h('dt', 'Admin rights'), h('dd', privileges.length ? privileges.join(' · ') : 'none'),
      h('dt', 'Server'), h('dd', serverLabel(info.serverVersion)),
      info.systemMode ? [h('dt', 'System mode'), h('dd', info.systemMode)] : null),
    h('div.account-actions',
      can('Secure') && info.username ? h('a', { href: `#/users/${encodeURIComponent(info.username)}`, onclick: closeAccount }, 'My user record') : null,
      h('button', { onclick: () => { closeAccount(); signOut(); } }, 'Sign out')));
  document.querySelector('.topbar').append(accountMenu);
  document.querySelector('.account-button').setAttribute('aria-expanded', 'true');
  accountMenu.querySelector('a, button').focus();
  document.addEventListener('mousedown', onOutside);
  document.addEventListener('keydown', onAccountKey);
  // Roles come from the extension (the SysAdmin API reports privileges, not role names).
  ext.get('/whoami').then((w) => { roles.textContent = w.roles ? w.roles.split(',').join(' · ') : 'none'; },
    () => { roles.textContent = 'not available'; });
}

// What the command palette offers: the screens this user may open and a few shell actions.
function paletteSources() {
  return {
    screens: NAV.flatMap((g) => g.items.filter((i) => !i.priv || can(...i.priv)).map((i) => ({ label: i.label, group: g.group, path: i.path }))),
    actions: [
      { label: 'Toggle API console', run: () => toggleConsole() },
      { label: 'Toggle light / dark theme', run: cycleTheme },
      { label: 'Sign out', run: signOut },
    ],
    navigate,
    can,
  };
}

async function signOut() {
  await logout();
  // The next sign-in starts at the dashboard; after an expired session or via a shared link it returns to that page.
  history.replaceState(null, '', '#/dashboard');
  renderLogin();
}

function cycleTheme() {
  const cur = document.documentElement.dataset.theme;
  applyTheme(cur === 'dark' ? 'light' : 'dark'); // light is the default look
}

function toggleConsole(show) {
  if (!consolePanel) return;
  consolePanel.hidden = show === undefined ? !consolePanel.hidden : !show;
  if (!consolePanel.hidden) drawConsole();
}

function drawConsole() {
  if (!consoleList || consolePanel.hidden) return;
  clear(consoleList, calls.slice().reverse().map((c) => h('li',
    h(`span.method.${c.method.toLowerCase()}`, c.method),
    h(`span.status${c.status >= 400 ? '.bad' : ''}`, String(c.status)),
    h('code', decodeURIComponent(c.url.replace(location.origin, ''))),
    h('span.muted', `${c.ms} ms`),
    h('button.small', { onclick: () => copy(curl(c.method, c.url, c.body)) }, 'curl'))));
}

onCall((c) => {
  calls.push(c);
  if (calls.length > 200) calls.shift();
  drawConsole();
});

let currentLoad = 0;
async function route() {
  if (!admin.loggedIn) return;
  const [path, ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  const r = ROUTES[path] || ROUTES.dashboard;
  if (!ROUTES[path]) history.replaceState(null, '', '#/dashboard');
  document.body.classList.remove('nav-open');
  syncSidebar();
  // Dialogs belong to the screen that opened them.
  closePalette();
  closeModals();
  closeAccount();
  for (const a of navEl.querySelectorAll('.nav-item')) {
    a.classList.toggle('active', a.dataset.path === r.path);
    if (a.dataset.path === r.path) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  document.title = `${r.label} · IRIS Admin Deck`;
  const token = ++currentLoad;
  clear(main, loading());
  try {
    const mod = await import(r.module);
    if (token !== currentLoad) return;
    // Each route gets its own node; once replaced it is detached, so late async work of the
    // previous screen cannot render into the new one and pollers can stop via isConnected.
    const view = h('div.view');
    clear(main, view);
    await mod.default(view, rest.map(decodeURIComponent));
  } catch (e) {
    if (token === currentLoad) clear(main, errorBox(e));
    console.error(e);
  }
  if (!document.querySelector('[aria-modal="true"]')) main.focus({ preventScroll: true });
}

async function start() {
  try {
    session.info = await admin.get('/info');
  } catch (e) {
    if (e.status === 401) { await logout(); return renderLogin(); }
    toastError(e);
  }
  renderShell();
  route();
}

window.addEventListener('hashchange', route);
installPalette({
  get screens() { return paletteSources().screens; },
  get actions() { return paletteSources().actions; },
  navigate, can,
  enabled: () => admin.loggedIn && !!session.info,
});
window.addEventListener('session-expired', () => {
  if (!admin.loggedIn) logout().then(() => renderLogin('Your session expired. Please sign in again.'));
});
applyTheme();
applySidebar();
// Clickjacking guard: IRIS cannot send frame-ancestors for static files, so refuse to run inside a frame.
if (window.top !== window.self) root.textContent = 'IRIS Admin Deck cannot be displayed inside a frame.';
else if (admin.loggedIn) start(); else renderLogin();

export { ext };
