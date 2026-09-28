// Small DOM toolkit. All text goes through textContent (never innerHTML) so log lines,
// descriptions etc. coming from the server cannot inject markup.
import { curl, redact, ext, onCall, PREFIX } from './api.js';
import { verifiedChange, describeVerification } from './verify.js';
import { changeCall, outcomeOf, openChange, closeChange } from './changes.js';

let nextId = 0;
const uniqueId = () => `ui-${++nextId}`;

/** h('div.card#main', {onclick, title, dataset:{}}, child1, 'text', [children]) */
export function h(tag, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(tag);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
    }
  }
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || (v === false && !k.startsWith('aria-'))) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style' && typeof v === 'object') {
      // Custom properties (--name) need setProperty; plain assignment ignores them.
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, val); else el.style[prop] = val;
      }
    }
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, k.startsWith('aria-') ? String(v) : v === true ? '' : v);
  }
  append(el, children);
  // The field convention keeps the visible label beside its control.
  if (el.classList.contains('field')) {
    const label = el.querySelector(':scope > label:not([for])');
    const control = el.querySelector(':scope > input, :scope > select, :scope > textarea');
    if (label && control) {
      control.id ||= uniqueId();
      label.htmlFor = control.id;
    }
  }
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) { el.replaceChildren(); append(el, children); return el; }

// ---------- formatting ----------
export function fmtBytes(n) {
  if (n === null || n === undefined || n === '' || isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = Number(n);
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export function fmtDuration(sec) {
  sec = Math.floor(sec || 0);
  const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const mm = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m ${sec % 60}s`;
}
export const fmtBool = (v) => (v === true || v === 1 || v === '1' ? 'Yes' : v === false || v === 0 || v === '0' ? 'No' : (v ?? '—'));
export function fmtValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return fmtBool(v);
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join(', ') : '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function badge(text, kind = '') { return h(`span.badge${kind ? `.${kind}` : ''}`, text); }
export function statusBadge(ok, yes = 'Enabled', no = 'Disabled') { return badge(ok ? yes : no, ok ? 'ok' : 'muted'); }
export function severityBadge(sev) {
  const map = { 0: ['info', 'muted'], 1: ['warning', 'warn'], 2: ['severe', 'err'], 3: ['fatal', 'err'] };
  const [t, k] = map[sev] || map[0];
  return badge(t, k);
}

// ---------- toasts ----------
export function toast(message, kind = 'ok') {
  const box = document.getElementById(kind === 'err' ? 'toast-errors' : 'toast-status');
  const t = h(`div.toast.${kind}`, message);
  box.append(t);
  setTimeout(() => t.classList.add('hide'), 3800);
  setTimeout(() => t.remove(), 4300);
}
export function toastError(e) { toast(e && e.message ? e.message : String(e), 'err'); }

// Monochrome line icons from one same-origin sprite (img/icons.svg, symbol id = name).
export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(ns, 'use');
  use.setAttribute('href', `img/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

// ---------- modal ----------
const openModals = new Set();
/** Closes every open dialog (on navigation and when the session ends). */
export function closeModals() { [...openModals].reverse().forEach((close) => close()); }

export function modal(title, body, { actions = [], wide = false, onClose } = {}) {
  const opener = document.activeElement;
  const titleId = uniqueId();
  const background = [...document.body.children].filter((el) => el.id !== 'toasts');
  const inertBefore = background.map((el) => el.inert);
  const close = () => {
    if (!openModals.has(close)) return;
    // An async parent action can finish while a child confirmation is still open.
    const stack = [...openModals];
    stack.slice(stack.indexOf(close) + 1).reverse().forEach((dismiss) => dismiss());
    openModals.delete(close);
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    background.forEach((el, i) => { el.inert = inertBefore[i]; });
    if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
    else document.getElementById('main')?.focus();
    onClose && onClose();
  };
  const focusable = () => [...overlay.querySelectorAll('a[href],button,input,select,textarea,summary,[tabindex]')]
    .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length && !el.closest('[inert]'));
  const onKey = (e) => {
    if ([...openModals].at(-1) !== close || overlay.inert) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    if (e.key === 'Tab') {
      const items = focusable();
      const index = items.indexOf(document.activeElement);
      if (!items.length || index < 0 || (e.shiftKey ? index === 0 : index === items.length - 1)) {
        e.preventDefault();
        (items[e.shiftKey ? items.length - 1 : 0] || overlay.querySelector('.modal')).focus();
      }
    }
  };
  const overlay = h('div.overlay', { onclick: (e) => { if (e.target === overlay) close(); } },
    h(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
      h('header', h('h2', { id: titleId }, title), h('button.icon', { onclick: close, 'aria-label': 'Close', title: 'Close' }, icon('close'))),
      h('div.modal-body', body),
      actions.length ? h('footer', actions.map((a) => h(`button${a.kind ? `.${a.kind}` : ''}`, {
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try { const r = await a.onclick(); if (r !== false) close(); } catch (e) { toastError(e); } finally { btn.disabled = a.disabled ? a.disabled() : false; }
        },
      }, a.label))) : null));
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  background.forEach((el) => { el.inert = true; });
  openModals.add(close);
  (focusable().find((el) => el.matches('input,select,textarea')) || focusable()[0] || overlay.querySelector('.modal')).focus();
  return { close, el: overlay };
}

/** Panel describing the exact API call an action will make, with copy-as-curl (`opts` as for curl()). */
export function apiCallPreview(method, path, body, opts) {
  const cmd = curl(method, path, body, opts);
  return h('details.api-preview',
    h('summary', h('code', `${method} ${path}`)),
    body !== undefined ? h('pre', JSON.stringify(redact(body), null, 2)) : null,
    h('div.row', h('code.curl', cmd), h('button.small', { onclick: () => copy(cmd) }, 'Copy curl')));
}

export function copy(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copied to clipboard'), () => toast('Copy failed', 'err'));
}

// ---------- change log ----------
// Each confirmed change is recorded in the server's change log (changes.js) once it has run: the calls
// it made (method and path, taken from the API console feed) and its outcome. Sending is fire-and-forget:
// a log that cannot be written never delays or fails the change itself.
function sendChange(record) {
  if (!record || !ext.loggedIn) return;
  try {
    ext.request('POST', '/changes', { body: record, quiet: true }).catch(() => {});
  } catch { /* never let the log break a change */ }
}

/**
 * Runs `fn(op)`, then records what it changed. `op` is this operation (changes.js openChange): a change run
 * inside `fn` gets it as `parent`, records itself and this one is not recorded again. `always`: also when it
 * made no write call. A refused stale edit wrote nothing but is recorded.
 */
async function recorded(what, fn, outcome, { always = true, parent = null } = {}) {
  const op = openChange(parent);
  const stop = onCall((entry) => { const c = changeCall(entry, PREFIX); if (c) op.calls.push(c); });
  let result;
  try {
    result = await fn(op);
  } catch (e) {
    stop();
    sendChange(closeChange(op, what, outcomeOf(null, e), { always }));
    throw e;
  }
  stop();
  sendChange(closeChange(op, what, outcome(result), { always }));
  return result;
}

/**
 * Runs a change as a verified change (see verify.js), reports the outcome as a toast and records it
 * in the change log. `what` names the change in the message ("Task suspended"); `parent`: the operation
 * it runs in, if any (see recorded()).
 */
export async function applyVerified(options, what, parent = null) {
  const outcome = await recorded(what, () => verifiedChange(options), (r) => outcomeOf(r), { parent });
  const [message, kind] = describeVerification(outcome, what);
  toast(message, kind);
  return outcome;
}

/**
 * Confirmation for a mutating call. Shows what will be called; runs `run()` on confirm.
 * call:    {method, path, body, basic?}, or an array of them when the action makes several calls
 * verify:  {read, original?, changes?, expect?} — makes it a verified change (verify.js)
 * confirmText: when set, the user must type this text (e.g. the object's name) to confirm.
 * check:   async () => {body, refuse} run when the dialog opens (who loses what, see impact.js); the confirm
 *          button stays disabled until it answers, and for good when `refuse` is set or the check fails.
 *          It runs again on confirm: what changed meanwhile (another administrator disabled) can refuse it.
 * what:    change log title (default done or title); must not carry request values such as a token.
 * outcome: (result of run) => {outcome, details} for the log of an unverified change (default unverified).
 */
export function confirmAction({ title, message, call, danger = false, confirmLabel = 'Confirm', run, done, verify, confirmText, check, what, outcome }) {
  return new Promise((resolve) => {
    const typed = confirmText ? h('input', { type: 'text', autocomplete: 'off', 'aria-label': `Type ${confirmText} to confirm` }) : null;
    const checked = check ? h('div.access-check', loading('Checking who is affected…')) : null;
    let busy = false; let blocked = !!check;
    const matches = () => !typed || typed.value === confirmText;
    const showCheck = ({ body, refuse }) => clear(checked, body, refuse ? h('div.error-box.refusal', h('strong', refuse)) : null);
    const showCheckError = (e) => clear(checked, h('div.error-box.refusal', h('strong', 'Could not work out who is affected, so this change is blocked: '), e.message));
    const m = modal(title, [
      h('p', message),
      checked,
      typed ? h('div.field.confirm-type', h('label', 'Type ', h('code', confirmText), ' to confirm'), typed) : null,
      call ? [call].flat().map((c) => apiCallPreview(c.method, c.path, c.body, { basic: c.basic })) : null,
    ], {
      onClose: () => resolve(false),
      actions: [
        { label: 'Cancel', onclick: () => {} },
        {
          label: confirmLabel,
          kind: danger ? 'danger' : 'primary',
          disabled: () => busy || blocked || !matches(),
          onclick: async () => {
            if (blocked || !matches()) return false;
            busy = true;
            try {
              // The snapshot of the first check may be stale by now: checked again right before the write.
              if (check) {
                let again;
                try { again = await check(); } catch (e) { blocked = true; showCheckError(e); return false; }
                if (again.refuse) { blocked = true; showCheck(again); return false; }
              }
              const logTitle = what || done || title;
              let r;
              if (verify) r = (await applyVerified({ ...verify, write: run }, logTitle)).result;
              else {
                // Recorded (unverified unless `outcome` says otherwise) only when it wrote something: the API explorer also sends reads here.
                r = await recorded(logTitle, run, outcome || (() => ({ outcome: 'unverified' })), { always: false });
                if (done) toast(done);
              }
              resolve(r === undefined ? true : r);
            } finally { busy = false; }
          },
        },
      ],
    });
    // The confirm button stays disabled until the exact text is typed and the check has passed.
    const confirmBtn = m.el.querySelector('footer button:last-child');
    const sync = () => { confirmBtn.disabled = busy || blocked || !matches(); };
    sync();
    if (typed) {
      typed.addEventListener('input', sync);
      typed.focus();
    }
    if (check) {
      check().then((r) => { blocked = !!r.refuse; showCheck(r); }, showCheckError).finally(sync);
    }
  });
}

// ---------- table ----------
/**
 * columns: [{key, label, render?(row)->Node|string, sort?(row)->value, width?}]
 * opts: {rows, filter: true, empty, onRow(row), actions(row)->[Node], pageSize}
 */
export function table(columns, rows, opts = {}) {
  const state = { sortKey: opts.sortKey || null, dir: 1, q: '', page: 0 };
  const pageSize = opts.pageSize || 100;
  const wrap = h('div.table-wrap');
  const tools = h('div.table-tools');
  const count = h('span.muted');
  if (opts.filter !== false) {
    tools.append(h('input.filter', {
      type: 'search', placeholder: opts.placeholder || 'Filter…', 'aria-label': 'Filter rows',
      oninput: (e) => { state.q = e.target.value.toLowerCase(); state.page = 0; draw(); },
    }));
  }
  tools.append(count);
  if (opts.tools) tools.append(...[opts.tools].flat());
  const tbl = h('table');
  const pager = h('div.pager');
  // Small fixed tables (filter: false, no tools) need no toolbar at all.
  wrap.append(...(opts.filter === false && !opts.tools ? [] : [tools]), h('div.table-scroll', tbl), pager);

  const val = (c, r) => (c.sort ? c.sort(r) : r[c.key]);
  function draw() {
    let data = rows;
    if (state.q) {
      data = rows.filter((r) => columns.some((c) => String(val(c, r) ?? '').toLowerCase().includes(state.q))
        || JSON.stringify(r).toLowerCase().includes(state.q));
    }
    if (state.sortKey) {
      const c = columns.find((x) => x.key === state.sortKey);
      data = [...data].sort((a, b) => {
        const x = val(c, a); const y = val(c, b);
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * state.dir;
        return String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true }) * state.dir;
      });
    }
    count.textContent = `${data.length} of ${rows.length}`;
    const pages = Math.max(1, Math.ceil(data.length / pageSize));
    state.page = Math.min(state.page, pages - 1);
    const slice = data.slice(state.page * pageSize, (state.page + 1) * pageSize);
    const head = h('tr', columns.map((c) => h('th', {
      style: c.width ? { width: c.width } : null,
      class: state.sortKey === c.key ? (state.dir > 0 ? 'asc' : 'desc') : null,
      scope: 'col', 'aria-sort': state.sortKey === c.key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none',
    }, h('button.sort-header', { onclick: () => {
      if (state.sortKey === c.key) state.dir *= -1; else { state.sortKey = c.key; state.dir = 1; }
      draw(); tbl.querySelectorAll('.sort-header')[columns.indexOf(c)].focus();
    } }, c.label))), opts.actions ? h('th.actions-col', '') : null);
    const body = slice.length ? slice.map((r) => h(`tr${opts.onRow ? '.clickable' : ''}`, {
      tabindex: opts.onRow ? '0' : null,
      onkeydown: opts.onRow ? (e) => { if (e.target === e.currentTarget && ['Enter', ' '].includes(e.key)) { e.preventDefault(); opts.onRow(r); } } : null,
      onclick: opts.onRow ? (e) => { if (!e.target.closest('button,a,input,select,textarea,summary,[contenteditable]')) opts.onRow(r); } : null,
    }, columns.map((c) => h('td', c.render ? c.render(r) : fmtValue(r[c.key]))),
    opts.actions ? h('td.actions', opts.actions(r)) : null))
      : [h('tr', h('td.empty', { colspan: columns.length + (opts.actions ? 1 : 0) }, opts.empty || 'Nothing here.'))];
    clear(tbl, h('thead', head), h('tbody', body));
    clear(pager, pages > 1 ? [
      h('button.small', { disabled: state.page === 0, onclick: () => { state.page--; draw(); } }, '‹ Prev'),
      h('span.muted', ` Page ${state.page + 1} / ${pages} `),
      h('button.small', { disabled: state.page >= pages - 1, onclick: () => { state.page++; draw(); } }, 'Next ›'),
    ] : []);
  }
  draw();
  wrap.update = (newRows) => { rows = newRows; draw(); };
  return wrap;
}

// ---------- key/value details ----------
export function kv(obj, { skip = [] } = {}) {
  return h('dl.kv', Object.entries(obj || {}).filter(([k]) => !skip.includes(k)).map(([k, v]) => [
    h('dt', k), h('dd', typeof v === 'object' && v !== null && !Array.isArray(v) ? h('pre', JSON.stringify(v, null, 2)) : fmtValue(v)),
  ]));
}

// ---------- forms ----------
/**
 * Generic editor for a flat JSON object (as returned by GET detail endpoints).
 * fields: optional [{key,label,type:'text'|'number'|'bool'|'select'|'password'|'textarea'|'json', options, help, required}]
 * When fields is omitted, types are inferred from the object values.
 * Returns {el, value()} — value() returns only keys present in fields/object.
 */
export function objectForm(obj, fields, { readonly = [] } = {}) {
  obj = obj || {};
  const defs = fields || Object.keys(obj).map((key) => {
    const v = obj[key];
    return { key, type: typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : (v && typeof v === 'object') ? 'json' : 'text' };
  });
  const inputs = {};
  const el = h('div.form-grid', defs.map((f) => {
    const v = obj[f.key] ?? f.default;
    const ro = readonly.includes(f.key) || f.readonly;
    let input;
    switch (f.type) {
      case 'bool': input = h('input', { type: 'checkbox', checked: v === true || v === 1 || v === '1', disabled: ro }); break;
      case 'number': input = h('input', { type: 'number', value: v ?? '', disabled: ro }); break;
      case 'password': input = h('input', { type: 'password', autocomplete: 'new-password', value: v ?? '', disabled: ro }); break;
      case 'textarea': input = h('textarea', { rows: 4, disabled: ro }, v ?? ''); break;
      case 'json': input = h('textarea.mono', { rows: 4, disabled: ro }, v === undefined ? '' : JSON.stringify(v, null, 2)); break;
      case 'select': input = h('select', { disabled: ro }, (f.options || []).map((o) => {
        const [ov, ol] = Array.isArray(o) ? o : [o, o];
        return h('option', { value: ov, selected: String(ov) === String(v) }, ol);
      })); break;
      default: input = h('input', { type: 'text', value: v ?? '', disabled: ro, required: f.required || false });
    }
    input.id = `f-${f.key.replace(/\W/g, '_')}-${uniqueId()}`;
    inputs[f.key] = { input, f };
    return h(`div.field${f.type === 'bool' ? '.check' : ''}${f.type === 'json' || f.type === 'textarea' ? '.span' : ''}`,
      h('label', { for: input.id }, f.label || f.key), input, f.help ? h('small.muted', f.help) : null);
  }));
  function value() {
    const out = {};
    for (const [k, { input, f }] of Object.entries(inputs)) {
      if (readonly.includes(k) || f.readonly) continue;
      if (f.type === 'bool') out[k] = input.checked;
      else if (f.type === 'number') { if (input.value !== '') out[k] = Number(input.value); }
      else if (f.type === 'json') {
        if (input.value.trim() === '') continue;
        try { out[k] = JSON.parse(input.value); } catch { throw new Error(`Field ${k}: invalid JSON`); }
      } else if (f.type === 'password') { if (input.value !== '') out[k] = input.value; }
      else out[k] = input.value;
      if (f.required && (out[k] === '' || out[k] === undefined)) throw new Error(`Field ${f.label || k} is required`);
    }
    return out;
  }
  return { el, value };
}

/** Only keys whose value changed compared to the original object. */
export function diff(original, updated) {
  const out = {};
  for (const [k, v] of Object.entries(updated)) {
    if (JSON.stringify(original ? original[k] : undefined) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}

// ---------- page scaffolding ----------
export function page(title, subtitle, ...content) {
  return h('section.page', h('header.page-head', h('div', h('h1', title), subtitle ? h('p.muted', subtitle) : null)), content);
}
export function toolbar(...items) { return h('div.toolbar', items); }
export function button(label, onclick, kind = '') { return h(`button${kind ? `.${kind}` : ''}`, { onclick }, label); }
export function loading(text = 'Loading…') { return h('div.loading', h('span.spinner'), text); }
export function errorBox(e, retry) {
  const forbidden = e && e.status === 403;
  // A read-only proxy in front of IRIS (the public demo) refuses writes itself: that is not about the user's roles.
  const byProxy = forbidden && e.payload && e.payload.status && e.payload.status.summary === 'read-only demo';
  return h('div.error-box', h('strong', forbidden ? 'Not permitted' : 'Request failed'),
    h('p', e && e.message ? e.message : String(e)),
    forbidden && !byProxy ? h('p.muted', 'Your roles do not grant the privilege this screen needs (see the API console for the call).') : null,
    retry ? button('Retry', retry) : null);
}

/** Loads data with a spinner, renders or shows an error box with retry. */
export async function load(container, fetcher, render) {
  const run = async () => {
    clear(container, loading());
    try {
      const data = await fetcher();
      clear(container, render(data));
    } catch (e) {
      clear(container, errorBox(e, run));
    }
  };
  await run();
  return run;
}

export function tabs(defs, active) {
  const prefix = uniqueId();
  const bar = h('div.tabs', { role: 'tablist', 'aria-label': 'Sections' });
  const body = h('div.tab-body', { role: 'tabpanel', id: `${prefix}-panel`, tabindex: '0' });
  const select = (id) => {
    const d = defs.find((x) => x.id === id) || defs[0];
    for (const b of bar.children) {
      const selected = b.dataset.id === d.id;
      b.classList.toggle('active', selected);
      b.setAttribute('aria-selected', String(selected));
      b.tabIndex = selected ? 0 : -1;
    }
    body.setAttribute('aria-labelledby', `${prefix}-${d.id}`);
    const content = h('div');
    clear(body, content);
    d.render(content);
  };
  for (const [i, d] of defs.entries()) bar.append(h('button.tab', {
    role: 'tab', id: `${prefix}-${d.id}`, 'aria-controls': body.id, dataset: { id: d.id },
    onclick: () => select(d.id),
    onkeydown: (e) => {
      const index = { ArrowRight: (i + 1) % defs.length, ArrowLeft: (i - 1 + defs.length) % defs.length,
        Home: 0, End: defs.length - 1 }[e.key];
      if (index === undefined) return;
      e.preventDefault(); select(defs[index].id); bar.children[index].focus();
    },
  }, d.label));
  select(active || defs[0].id);
  return h('div', bar, body);
}

export function meter(pct, label) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const kind = p >= 90 ? 'err' : p >= 75 ? 'warn' : 'ok';
  return h('div.meter', { role: 'meter', 'aria-valuenow': p, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': label || 'usage' },
    h(`div.meter-fill.${kind}`, { style: { width: `${p}%` } }));
}

export function stat(label, value, sub) {
  return h('div.stat', h('div.stat-label', label), h('div.stat-value', value), sub ? h('div.stat-sub', sub) : null);
}

/** Line chart of the latest `slots` values (drawn right-aligned while fewer are known), with the latest value beside it. */
export function sparkline(values, color, { max, slots = values.length, format = (v) => v.toLocaleString('en-US'), times, label = '' } = {}) {
  const w = 400; const hgt = 60;
  const valid = values.map((v, i) => v == null ? null : { v, i }).filter(Boolean);
  const top = max || Math.max(1e-9, ...valid.map(({ v }) => v));
  const step = w / Math.max(1, Math.max(slots, values.length) - 1);
  const offset = w - (values.length - 1) * step;
  const point = ({ v, i }) => ({ x: offset + i * step, y: hgt - 2 - (v / top) * (hgt - 6) });
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', valid.length ? `latest ${format(valid.at(-1).v)}` : 'no data yet');
  Object.assign(svg.style, { width: '100%', height: '60px', display: 'block' });
  if (values.length > 1) {
    const pts = values.map((v, i) => v == null ? null : point({ v, i }));
    const segments = []; let segment = [];
    for (const p of [...pts, null]) {
      if (p) segment.push(p);
      else if (segment.length) { segments.push(segment); segment = []; }
    }
    for (const segment of segments) {
      const area = document.createElementNS(ns, 'polygon');
      const coords = segment.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
      area.setAttribute('points', `${segment[0].x},${hgt} ${coords} ${segment.at(-1).x},${hgt}`);
      area.setAttribute('fill', color);
      area.setAttribute('opacity', '0.12');
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', coords);
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '1.5');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(area, line);
    }
  }
  const last = values[values.length - 1];
  const guide = h('span.spark-guide');
  const dot = h('span.spark-dot');
  const tooltip = h('span.spark-tooltip');
  const plot = h('div.spark-plot', { style: { '--spark-color': color } }, svg, guide, dot, tooltip);
  plot.addEventListener('pointermove', (e) => {
    if (!valid.length) return;
    const rect = plot.getBoundingClientRect();
    const x = (e.clientX - rect.left) * w / rect.width;
    const nearest = valid.reduce((a, b) => Math.abs(point(b).x - x) < Math.abs(point(a).x - x) ? b : a);
    const { x: px, y } = point(nearest);
    const left = px * rect.width / w;
    guide.style.left = dot.style.left = `${left}px`;
    dot.style.top = `${y * rect.height / hgt}px`;
    const time = times?.[nearest.i];
    const clock = time == null ? '' : ` · ${new Date(time * 1000).toTimeString().slice(0, 8)}`;
    tooltip.textContent = `${format(nearest.v)}${label ? ` ${label}` : ''}${clock}`;
    plot.classList.add('inspecting');
    tooltip.style.left = `${Math.max(0, Math.min(rect.width - tooltip.offsetWidth, left - tooltip.offsetWidth / 2))}px`;
  });
  plot.addEventListener('pointerleave', () => plot.classList.remove('inspecting'));
  return h('div.spark', plot, h('strong.spark-value', last == null ? '—' : format(last)));
}
