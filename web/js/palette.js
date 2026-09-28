// Command palette (Ctrl+K / ⌘K): jump to any screen, run a shell action, or open a user, role,
// web application or task by name. Objects are fetched when the palette opens and cached briefly.
import { admin } from './api.js';
import { h, clear } from './ui.js';

const CACHE_MS = 60_000;
let cache = { at: 0, items: [] };
let generation = 0; // bumped on sign-out: responses started for a previous session are dropped
let open = null;

/**
 * Registers the keyboard shortcut. `sources` = { screens: [{label, group, path}], actions: [{label, run}],
 * navigate(path), can(...privs), enabled() } supplied by the app shell.
 */
export function installPalette(sources) {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      if (sources.enabled && !sources.enabled()) return;
      e.preventDefault();
      if (open) open.close(); else showPalette(sources);
    }
  });
}

// Objects worth jumping to, each tagged with the screen that shows it and the privilege it needs.
const OBJECT_SOURCES = [
  { kind: 'User', priv: ['Secure'], load: () => admin.get('/v2/security/users'), label: (u) => u.Name, sub: (u) => u.FullName, path: (u) => `users/${encodeURIComponent(u.Name)}` },
  { kind: 'Role', priv: ['Secure'], load: () => admin.get('/v2/security/roles'), label: (r) => r.Name, sub: (r) => r.Description, path: (r) => `roles/roles/${encodeURIComponent(r.Name)}` },
  { kind: 'Web app', priv: ['Secure'], load: () => admin.get('/v2/web-apps'), label: (a) => a.Name, sub: (a) => a.Description || a.NameSpace, path: (a) => `webapps/${encodeURIComponent(a.Name)}` },
  { kind: 'Task', priv: ['Operate', 'Task'], load: () => admin.get('/v2/tasks'), label: (t) => t.Name, sub: (t) => t.Description, path: (t) => `tasks/${t.Id}` },
];

async function loadObjects(can) {
  if (Date.now() - cache.at < CACHE_MS) return cache.items;
  const started = generation;
  const lists = await Promise.all(OBJECT_SOURCES.filter((s) => can(...s.priv)).map((s) => s.load()
    .then((rows) => rows.map((r) => ({ kind: s.kind, label: s.label(r), sub: s.sub(r) || '', path: s.path(r) })))
    .catch(() => [])));
  if (started !== generation) return [];
  cache = { at: Date.now(), items: lists.flat() };
  return cache.items;
}

/** Ranks an item for a query: exact/prefix/word-start matches first, plain substring last; 0 = no match. */
export function score(text, query) {
  const t = String(text).toLowerCase();
  const q = query.toLowerCase();
  if (!q) return 1;
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.split(/[\s/_.%-]+/).some((w) => w.startsWith(q))) return 60;
  const i = t.indexOf(q);
  return i >= 0 ? 40 - Math.min(i, 30) : 0;
}

function showPalette({ screens, actions, navigate, can }) {
  const input = h('input.palette-input', { type: 'text', placeholder: 'Go to a screen, user, role, web app or task…', 'aria-label': 'Command palette', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'palette-list', 'aria-autocomplete': 'list' });
  const list = h('ul#palette-list.palette-list', { role: 'listbox', 'aria-label': 'Commands' });
  const hint = h('div.palette-hint.muted.small', '↑↓ to move · Enter to open · Esc to close');
  const overlay = h('div.overlay.palette-overlay', { onclick: (e) => { if (e.target === overlay) close(); } },
    h('div.palette', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'palette-title' }, h('h2.sr-only#palette-title', 'Command palette'), input, list, hint));
  const base = [
    ...screens.map((s) => ({ kind: 'Screen', label: s.label, sub: s.group, path: s.path })),
    ...actions.map((a) => ({ kind: 'Action', label: a.label, sub: '', run: a.run })),
  ];
  let objects = [];
  let shown = [];
  let active = 0;
  const returnFocus = document.activeElement;
  const background = [...document.body.children].filter((el) => el.id !== 'toasts');
  const inertBefore = background.map((el) => el.inert);
  background.forEach((el) => { el.inert = true; });

  function close() {
    overlay.remove();
    background.forEach((el, i) => { el.inert = inertBefore[i]; });
    document.removeEventListener('keydown', onKey, true);
    open = null;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
  }
  function choose(item) {
    if (!item) return;
    close();
    if (item.run) item.run(); else navigate(item.path);
  }
  function draw() {
    const q = input.value.trim();
    shown = [...base, ...objects]
      .map((item) => ({ item, s: Math.max(score(item.label, q), score(item.sub, q) / 2) }))
      .filter((x) => x.s > 0)
      .map((x) => ({ ...x, s: x.s + (x.item.kind === 'Screen' ? 5 : 0) })) // screens win ties
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.item);
    active = Math.min(active, Math.max(shown.length - 1, 0));
    clear(list, shown.length ? shown.map((item, i) => h(`li.palette-item${i === active ? '.active' : ''}`, {
      role: 'option', 'aria-selected': String(i === active), id: `palette-opt-${i}`,
      onmousemove: () => { if (active !== i) { active = i; draw(); } },
      onclick: () => choose(item),
    }, h('span.badge', item.kind), h('span.palette-label', item.label), item.sub ? h('span.muted.small', item.sub) : null))
      : h('li.palette-empty.muted', objects.length ? 'No matches.' : 'No matches (still loading objects…)'));
    if (shown.length) input.setAttribute('aria-activedescendant', `palette-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }
  // Captures keys while open: the palette is modal, so handled keys do not reach dialogs underneath
  // and Tab keeps the focus in the search field.
  function onKey(e) {
    const handled = { Escape: close, Tab: () => input.focus(), Enter: () => choose(shown[active]),
      ArrowDown: () => { active = (active + 1) % Math.max(shown.length, 1); draw(); },
      ArrowUp: () => { active = (active - 1 + shown.length) % Math.max(shown.length, 1); draw(); } }[e.key];
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
    handled();
  }

  input.addEventListener('input', () => { active = 0; draw(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  input.focus();
  open = { close };
  draw();
  loadObjects(can).then((items) => { objects = items; if (open) draw(); });
}

/** Closes the palette if open (on navigation, so its key capture never outlives it). */
export function closePalette() {
  if (open) open.close();
}

/** Forgets cached objects (after sign-out, so the next user never sees them). */
export function resetPalette() {
  generation++;
  cache = { at: 0, items: [] };
  if (open) open.close();
}

/** Opens the palette programmatically (topbar search button). */
export function openPalette(sources) {
  if (!open) showPalette(sources);
}
