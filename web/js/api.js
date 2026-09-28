import { sessionSchedule, IDLE_MS } from './session.js';
import { jobs } from './jobs.js';
// API client for the SysAdmin API (/api/admin) and the Admin Deck extension (/admindeck/api).
// Both use JWT: POST <base>/login -> {access_token, refresh_token}. Tokens live in sessionStorage,
// the password is never stored. Each base keeps its own single-flight refresh.

export class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

// Request fields that must never be shown in the API console, previews or curl commands.
// Matches e.g. Password, ClientSecret, PrivateKeyPassword, InitialAccessToken — not token_endpoint
// or settings about passwords such as PasswordNeverExpires / PasswordExpirationDays.
const SENSITIVE = /password$|secret|privatekey|token$/i;
/** Deep copy of a request body with sensitive values replaced by "***". */
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE.test(k) && v !== '' && v !== null && typeof v !== 'boolean' ? '***' : redact(v),
      ]),
    );
  }
  return value;
}

const listeners = new Set();
/** Subscribe to every API call (used by the API console drawer). */
export function onCall(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const emit = (entry) => {
  const safe = { ...entry, body: redact(entry.body) };
  listeners.forEach((fn) => {
    try {
      fn(safe);
    } catch {
      /* ignore */
    }
  });
};

function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(sessionStorage.getItem(key) || 'null');
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    return null;
  }
  return value;
}

export function buildQuery(query) {
  if (!query) return '';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

function errorMessage(payload, status) {
  const st = payload && payload.status;
  if (st) {
    const errs = (st.errors || []).map((e) => e.error || e.message || JSON.stringify(e)).filter(Boolean);
    if (errs.length) return errs.join('; ');
    if (st.summary) return st.summary;
  }
  if (payload && payload.errors) return payload.errors.map((e) => e.error || e).join('; ');
  return status === 400 ? 'HTTP 400 Bad Request (no reason given)' : `HTTP ${status}`;
}

const activityKey = 'adminDeck.lastActivity';
let lastActivity = store(activityKey) || Date.now();
let expiring = false;
let idleTimer;
function scheduleIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => {
      if (sessionSchedule(null, lastActivity).expired) expireSession();
      else scheduleIdle();
    },
    Math.max(0, lastActivity + IDLE_MS - Date.now()),
  );
}
function expireSession() {
  if (expiring) return;
  expiring = true;
  logout().then(() => window.dispatchEvent(new CustomEvent('session-expired')));
}

class Client {
  constructor(base, key) {
    this.base = base;
    this.key = key;
    this.tokens = store(key) || null;
    this.refreshing = null;
    this.timer = null;
    this.generation = 0; // bumped on login/logout so late refresh results are discarded
  }

  get loggedIn() {
    return !!(this.tokens && this.tokens.access_token);
  }

  async login(user, password) {
    const res = await fetch(`${this.base}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token)
      throw new ApiError(errorMessage(data, res.status) || 'Login failed', res.status, data);
    this.generation++;
    this.setTokens(data);
  }

  setTokens(data) {
    this.tokens = data ? { access_token: data.access_token, refresh_token: data.refresh_token } : null;
    store(this.key, this.tokens);
    this.schedule();
    if (data) scheduleIdle();
  }

  schedule(retryMs) {
    clearTimeout(this.timer);
    if (!this.loggedIn) return;
    const plan = sessionSchedule(jwtExpiresIn(this.tokens.access_token), lastActivity);
    this.timer = setTimeout(
      () => this.keepAlive(),
      retryMs ? Math.min(Math.max(0, lastActivity + IDLE_MS - Date.now()), retryMs) : plan.delay,
    );
  }

  async keepAlive() {
    if (!this.loggedIn) return;
    if (sessionSchedule(null, lastActivity).expired) return expireSession();
    const gen = this.generation;
    try {
      if ((jwtExpiresIn(this.tokens.access_token) ?? Infinity) <= 10) await this.refresh();
      this.schedule();
    } catch (e) {
      if (gen !== this.generation) return;
      if (e.status === 401) expireSession();
      else this.schedule(5000); // transient network failure; retry without retaining credentials
    }
  }

  async logout() {
    const t = this.tokens;
    this.generation++;
    this.refreshing = null;
    this.setTokens(null);
    if (t && t.refresh_token) {
      fetch(`${this.base}/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.access_token}` },
        body: JSON.stringify({ refresh_token: t.refresh_token }),
      }).catch(() => {});
    }
  }

  // Single-flight: a refresh invalidates the previous pair, so concurrent 401s must share one refresh.
  refresh() {
    if (!this.refreshing) {
      const rt = this.tokens && this.tokens.refresh_token;
      const gen = this.generation;
      const pending = (async () => {
        if (!rt) throw new ApiError('Session expired', 401);
        const res = await fetch(`${this.base}/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: rt, grant_type: 'refresh_token' }),
        });
        const data = await res.json().catch(() => ({}));
        if (gen !== this.generation) throw new ApiError('Signed out', 401);
        if (!res.ok || !data.access_token) {
          this.setTokens(null);
          throw new ApiError('Session expired', 401, data);
        }
        this.setTokens(data);
      })().finally(() => {
        if (this.refreshing === pending) this.refreshing = null;
      });
      this.refreshing = pending;
    }
    return this.refreshing;
  }

  // quiet: a 401 does not end the UI session (a background call such as the change log must never sign anyone out).
  async request(method, path, { query, body, quiet = false } = {}) {
    if (this.loggedIn && sessionSchedule(null, lastActivity).expired) {
      expireSession();
      throw new ApiError('Session expired', 401);
    }
    const url = `${this.base}${path}${buildQuery(query)}`;
    const started = performance.now();
    const gen = this.generation; // the session this request belongs to
    const doFetch = () =>
      fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(this.tokens ? { Authorization: `Bearer ${this.tokens.access_token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    if (this.refreshing) await this.refreshing.catch(() => {});
    // A request must never be sent (or retried) with another sign-in's tokens.
    const sameSession = () => {
      if (gen !== this.generation) throw new ApiError('Signed out', 401);
    };
    sameSession();
    let res = await doFetch();
    if (res.status === 401 && this.tokens) {
      try {
        await this.refresh();
        sameSession();
        res = await doFetch();
      } catch (e) {
        emit({ method, url, body, status: 401, ms: Math.round(performance.now() - started) });
        if (!quiet) window.dispatchEvent(new CustomEvent('session-expired'));
        throw e;
      }
    }
    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    emit({ method, url, body, status: res.status, ms: Math.round(performance.now() - started) });
    if (res.status === 401 && !quiet) window.dispatchEvent(new CustomEvent('session-expired'));
    const st = payload && payload.status;
    if (!res.ok || (st && st.errors && st.errors.length)) {
      throw new ApiError(errorMessage(payload, res.status), res.status, payload);
    }
    if (res.status === 202) {
      // Long-running operations are queued: 202 + Location: .../async-result?id=<GUID>.
      // Poll GET /v2/async-result?id=<GUID> (see waitAsync) for State and Result.
      const loc = res.headers.get('Location') || '';
      const id = new URLSearchParams(loc.split('?')[1] || '').get('id');
      if (id) {
        taskLabels.set(id, `${method} ${path}`);
        return { GUID: id, State: 'Queued', TaskName: `${method} ${path}` };
      }
    }
    return payload && Object.prototype.hasOwnProperty.call(payload, 'result') ? payload.result : payload;
  }

  get(path, query) {
    return this.request('GET', path, { query });
  }
  post(path, body, query) {
    return this.request('POST', path, { body: body ?? {}, query });
  }
  put(path, body, query) {
    return this.request('PUT', path, { body, query });
  }
  del(path, query) {
    return this.request('DELETE', path, { query });
  }
}

// When IRIS is published under a path prefix by a reverse proxy (e.g. https://host/demo/admindeck/),
// every API URL must carry the same prefix.
export const PREFIX = location.pathname.includes('/admindeck/') ? location.pathname.split('/admindeck/')[0] : '';

export const admin = new Client(`${PREFIX}/api/admin`, 'adminDeck.adminTokens');

/**
 * Prometheus text of /api/monitor/metrics. Database free space and the mirror member type are there,
 * not in /api/admin/v2. The endpoint needs no token; it may be switched off or not proxied (then it throws).
 */
export async function monitorMetrics() {
  const url = `${PREFIX}/api/monitor/metrics`;
  const started = performance.now();
  const res = await fetch(url, { headers: { Accept: 'text/plain' } });
  emit({ method: 'GET', url, status: res.status, ms: Math.round(performance.now() - started) });
  if (!res.ok) throw new ApiError(`HTTP ${res.status}`, res.status);
  return res.text();
}

/**
 * Finds one row of a SysAdmin list endpoint by a field value — used to read back objects whose
 * GET-by-name endpoint does not exist (locks, sessions, wallet secrets) or whose id is unknown.
 * Throws a 404 ApiError when absent, so it works as a `read` for verified changes (verify.js).
 */
export async function findInList(path, query, key, value) {
  const row = (await admin.get(path, query)).find((r) => String(r[key]) === String(value));
  if (!row) throw new ApiError(`${key} ${value} not found`, 404);
  return row;
}

const taskLabels = new Map();
const FINAL_STATES = /finished|failed|cancel|error|complete|done/i;
/** Polls an async SysAdmin task, recording progress and its final outcome for this session. */
export async function waitAsync(id, { interval = 1500, timeoutMs = 10 * 60 * 1000, onUpdate, label } = {}) {
  const job = jobs.start(id, label || taskLabels.get(id) || `Background task ${id}`);
  taskLabels.delete(id);
  const gen = admin.generation;
  const until = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (gen !== admin.generation) throw new ApiError('Signed out', 401);
      const task = await admin.get('/v2/async-result', { id });
      if (gen !== admin.generation) throw new ApiError('Signed out', 401);
      const done = FINAL_STATES.test(String(task.State || ''));
      jobs.update(job, task, done);
      if (onUpdate) onUpdate(task);
      if (done) return task;
      if (Date.now() > until)
        throw new ApiError(`Background task ${id} is still running; monitoring timed out`, 408, task);
      await new Promise((r) => setTimeout(r, interval));
    }
  } catch (e) {
    jobs.update(
      job,
      { State: e.status === 408 ? 'Monitoring timed out' : 'Monitoring failed', Message: e.message },
      true,
    );
    throw e;
  }
}
export const ext = new Client(`${PREFIX}/admindeck/api`, 'adminDeck.extTokens');

/** Logs in to both applications with the same credentials. The extension is optional. */
export async function login(user, password) {
  expiring = false;
  lastActivity = Date.now();
  store(activityKey, lastActivity);
  jobs.clear();
  await admin.login(user, password);
  try {
    await ext.login(user, password);
  } catch (e) {
    await ext.logout(); // never keep the previous user's extension session
    console.warn('Extension login failed', e);
  }
}

export async function logout() {
  clearTimeout(idleTimer);
  jobs.clear();
  taskLabels.clear();
  store(activityKey, null);
  await Promise.all([admin.logout(), ext.logout()]);
}

/** Seconds until a JWT expires (from its exp claim), or null when it cannot be read. */
export function jwtExpiresIn(token, now = Date.now()) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const exp = JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4))).exp;
    return typeof exp === 'number' ? exp - now / 1000 : null;
  } catch {
    return null;
  }
}

/**
 * One request to any web application of this instance (the explorer's "Try it"). With `auth`, the portal's
 * SysAdmin token goes as the Bearer: IRIS accepts it on every application with JWT authentication enabled,
 * but /api/mgmnt, /api/atelier and other password-only applications answer 401. It is refreshed first when
 * about to expire; a 401 here is the tried application's answer, so it never retries or signs out.
 * Resolves with {status, statusText, headers: [[name, value]], body (text), ms}.
 */
export async function rawCall(method, path, { body, auth = true } = {}) {
  if (auth && admin.loggedIn && (jwtExpiresIn(admin.tokens.access_token) ?? 60) < 5)
    await admin.refresh().catch(() => {});
  const url = `${PREFIX}${path}`;
  const started = performance.now();
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(auth && admin.loggedIn ? { Authorization: `Bearer ${admin.tokens.access_token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'omit', // never a CSP session cookie: only what the curl command would send
    redirect: 'manual',
  });
  const text = method === 'HEAD' ? '' : await res.text();
  const ms = Math.round(performance.now() - started);
  emit({ method, url, body, status: res.status, ms });
  return { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body: text, ms };
}

/**
 * Equivalent curl command for an API call (shown in confirmations and the API console).
 * `basic`: the application does not take a JWT, so curl signs in with user and password (-u prompts for it).
 */
export function curl(method, url, body, { basic = false } = {}) {
  const full = url.startsWith('http') ? url : `${location.origin}${url.startsWith(PREFIX + '/') ? '' : PREFIX}${url}`;
  let cmd = `curl -X ${method} ${basic ? '-u "$IRIS_USER"' : '-H "Authorization: Bearer $TOKEN"'}`;
  if (body !== undefined)
    cmd += ` -H "Content-Type: application/json" -d '${JSON.stringify(redact(body)).replace(/'/g, "'\\''")}'`;
  return `${cmd} '${full}'`;
}

// Start after module initialization so restored sessions use the same expiry path as live sessions.
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const activity = () => {
    if (!admin.loggedIn) return;
    if (sessionSchedule(null, lastActivity).expired) return expireSession();
    lastActivity = Date.now();
    store(activityKey, lastActivity);
  };
  for (const name of ['pointerdown', 'pointermove', 'keydown'])
    document.addEventListener(name, activity, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      admin.keepAlive();
      ext.keepAlive();
    }
  });
  admin.schedule();
  ext.schedule();
  if (admin.loggedIn) {
    store(activityKey, lastActivity);
    scheduleIdle();
  }
}
