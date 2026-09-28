// Change log entries (POST /admindeck/api/changes): what was changed, which calls it took and how the
// read-back came out. Only method and path of each call are kept, never a body: bodies may hold
// passwords or keys. Pure functions; the sending lives in ui.js.
import { StaleError } from './verify.js';

export const MAX_CALLS = 10;
export const MAX_DETAILS = 500;
const MAX_WHAT = 200;

// Query-string values that must not end up in the log (e.g. ?token=..., ?ClientSecret=...).
const SECRET_PARAM = /password|secret|token/i;
// POSTs that only read are not changes: exactly these endpoints; anything else posted may write.
const READ_ONLY_POST = new Set([
  '/api/admin/v2/security/audit/records',
  '/api/admin/v2/journal/file/records',
  '/api/admin/v2/database-dir/info',
]);
const LOG_PATH = /\/admindeck\/api\/changes$/;

/** Path with the values of password/secret/token query parameters replaced by ***. */
export function redactPath(path) {
  const [base, query] = String(path).split(/\?(.*)/s);
  if (query === undefined) return base;
  return `${base}?${query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const name = eq < 0 ? pair : pair.slice(0, eq);
      let decoded = name;
      try {
        decoded = decodeURIComponent(name.replace(/\+/g, ' '));
      } catch {
        /* keep as sent */
      }
      return eq >= 0 && SECRET_PARAM.test(decoded) ? `${name}=***` : pair;
    })
    .join('&')}`;
}

/** Free text (a title, an error message) with the values of password/secret/token name=value pairs replaced by ***. */
export function redactText(text) {
  return String(text ?? '').replace(/([^\s?&=;,"']+)=([^&\s#"',;]*)/g, (pair, name) => {
    let decoded = name;
    try {
      decoded = decodeURIComponent(name.replace(/\+/g, ' '));
    } catch {
      /* keep as sent */
    }
    return SECRET_PARAM.test(decoded) ? `${name}=***` : pair;
  });
}

/**
 * {method, path} of an API console entry ({method, url}) that changes something, else null.
 * `prefix` is the reverse-proxy path prefix (api.js PREFIX): the log keeps IRIS paths.
 */
export function changeCall({ method, url }, prefix = '') {
  const m = String(method || '').toUpperCase();
  if (!m || m === 'GET' || m === 'HEAD') return null;
  let path = String(url || '');
  try {
    const u = new URL(path, 'http://x');
    path = u.pathname + u.search;
  } catch {
    return null;
  }
  if (prefix && path.startsWith(`${prefix}/`)) path = path.slice(prefix.length);
  const bare = path.split('?')[0];
  if ((m === 'POST' && READ_ONLY_POST.has(bare)) || LOG_PATH.test(bare) || /\/(login|logout|refresh)$/.test(bare))
    return null;
  return { method: m, path: redactPath(path) };
}

/** {outcome, details} for a verifiedChange() result, or for the error a change ended with. */
export function outcomeOf(result, error) {
  if (error) {
    const message = String((error && error.message) || error);
    return { outcome: error instanceof StaleError ? 'refused' : 'failed', details: message };
  }
  const { status = 'unverified', mismatched = [], unchecked = [], error: readError } = result || {};
  const details =
    status === 'not-reflected'
      ? mismatched.join(', ')
      : status === 'partly-verified'
        ? `not returned by the API: ${unchecked.join(', ')}`
        : status === 'read-failed'
          ? String((readError && readError.message) || '')
          : '';
  return { outcome: status, details };
}

/** Request body for POST /changes, capped the way the server caps it. */
export function changeRecord(what, calls, { outcome, details = '' }) {
  return {
    what: redactText(what || 'Change').slice(0, MAX_WHAT),
    calls: (calls || []).slice(0, MAX_CALLS).map(({ method, path }) => ({ method, path: redactPath(path) })),
    outcome,
    details: redactText(details || '').slice(0, MAX_DETAILS),
  };
}

/**
 * One change being recorded. Nesting is per operation, not global: a change run inside another (the
 * `parent`) records itself and marks its ancestors as recorded; an unrelated change finishing meanwhile
 * leaves them alone. `calls` are what this operation saw.
 */
export function openChange(parent = null) {
  return { parent, calls: [], recorded: false };
}

/**
 * The POST /changes body when `op` ends with `result` ({outcome, details}), or null: already recorded by a
 * nested change, or (`always` off) nothing written and nothing refused. Marks `op` and its ancestors.
 */
export function closeChange(op, what, result, { always = true } = {}) {
  if (op.recorded) return null;
  if (!always && !op.calls.length && result.outcome !== 'refused') return null;
  for (let o = op; o; o = o.parent) o.recorded = true;
  return changeRecord(what, op.calls, result);
}

/** Badge colour of an outcome: ok, warn, err or muted. */
export function outcomeKind(outcome) {
  if (outcome === 'verified' || outcome === 'partly-verified') return 'ok';
  if (outcome === 'failed') return 'err';
  if (outcome === 'unverified') return 'muted';
  return 'warn';
}

/** The log as CSV (one row per change, calls joined by "; "), for a ticket or a spreadsheet. */
export function changesCsv(rows) {
  // A cell starting with = + - @ tab or CR is a formula to a spreadsheet: a leading ' keeps it text.
  const cell = (v) => {
    const s = /^[=+\-@\t\r]/.test(String(v)) ? `'${v}` : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [['time', 'user', 'what', 'outcome', 'details', 'calls'].join(',')];
  for (const r of rows || []) {
    const calls = (r.calls || []).map((c) => `${c.method} ${c.path}`).join('; ');
    lines.push([r.time, r.user, r.what, r.outcome, r.details || '', calls].map((v) => cell(v ?? '')).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
