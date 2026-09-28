// Verified changes. A "200 OK" only says the request was accepted, so every change is checked twice:
//   before — the target is read again and the write is refused if the fields about to change no
//            longer hold the values the user was looking at (someone else changed them meanwhile);
//   after  — the target is read back and the outcome is reported as verified or not reflected.
// Only fields that can be read back are compared; secret values (passwords, keys) never are, but
// flags about them (PasswordNeverExpires, ChangePassword) are ordinary readable settings.

// Write-only values: passwords (incl. PrivateKeyPassword), secrets, tokens. Paths such as PrivateKeyFile are readable.
const SECRET = /password|secret|token$/i;
const isSecret = (key, value) => SECRET.test(key) && typeof value !== 'boolean';

// Field-specific equivalences: IRIS reports "no expiration" as 1840-12-31 but accepts "" for it.
const FIELD_NORMALISERS = { ExpirationDate: (v) => (v === '1840-12-31' ? '' : v) };

/** Thrown when the object changed between opening the form and saving it. */
export class StaleError extends Error {
  constructor(fields, current) {
    super(`Changed by someone else since you opened it: ${fields.join(', ')}. Reopen it and try again.`);
    this.fields = fields;
    this.current = current;
  }
}

// Comparable form of a value: IRIS returns booleans for flags that were sent as 1/0 and may
// reorder list items (roles, allow-lists), so both are normalised.
export function normalise(v) {
  if (v === true || v === 1 || v === '1') return '1';
  if (v === false || v === 0 || v === '0') return '0';
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(normalise).map((x) => JSON.stringify(x)).sort().join('\u0001');
  if (typeof v === 'object') return JSON.stringify(Object.keys(v).sort().map((k) => [k, normalise(v[k])]));
  return String(v);
}
export const same = (a, b) => normalise(a) === normalise(b);
const sameField = (key, a, b) => {
  const f = FIELD_NORMALISERS[key] || ((v) => v);
  return same(f(a), f(b));
};

/** Keys of `changes` that can be compared after a write (secret values and write-only blobs are not). */
function comparable(changes) {
  return Object.keys(changes || {}).filter((k) => !isSecret(k, changes[k]));
}

const isNotFound = (e) => e && (e.status === 404 || /does not exist|not found/i.test(e.message || ''));

/**
 * Performs `write()` as a verified change.
 *   read      async () => current object (throws when it does not exist)
 *   write     async () => result of the API call
 *   original  object as the user saw it (enables the stale check), optional
 *   changes   fields being set, compared before (vs original) and after (vs read-back)
 *   expect    'match' (default) | 'exists' (object readable afterwards) | 'gone' (deleted)
 * Returns { result, status: 'verified' | 'not-reflected' | 'unverified', mismatched: [keys] }.
 */
export async function verifiedChange({ read, write, original, changes = {}, expect = 'match' }) {
  const keys = comparable(changes);
  if (original && read) {
    let current;
    try {
      current = await read();
    } catch (e) {
      if (isNotFound(e)) throw new StaleError(['the object was deleted'], null);
      throw e;
    }
    const moved = keys.filter((k) => k in current && k in original && !sameField(k, current[k], original[k]));
    if (moved.length) throw new StaleError(moved, current);
  }

  const result = await write();
  if (!read) return { result, status: 'unverified', mismatched: [] };
  // Background operations (202 Accepted) are verified by their own progress view.
  if (result && result.GUID && result.State === 'Queued') return { result, status: 'unverified', mismatched: [] };

  let after = null;
  try {
    after = await read();
  } catch (e) {
    if (expect === 'gone' && isNotFound(e)) return { result, status: 'verified', mismatched: [] };
    return { result, status: 'unverified', mismatched: [], error: e };
  }
  if (expect === 'gone') return { result, status: 'not-reflected', mismatched: ['still exists'] };
  if (expect === 'exists') return { result, status: 'verified', mismatched: [] };
  const checkable = keys.filter((k) => after && k in after);
  const mismatched = checkable.filter((k) => !sameField(k, after[k], changes[k]));
  return { result, status: mismatched.length ? 'not-reflected' : checkable.length ? 'verified' : 'unverified', mismatched, after };
}

/** Short human message for a verification outcome. */
export function describeVerification({ status, mismatched }, what = 'Change') {
  if (status === 'verified') return [`${what}. Read back: OK`, 'ok'];
  if (status === 'not-reflected') return [`${what}, but the read-back differs: ${mismatched.join(', ')}`, 'warn'];
  return [`${what}. Accepted; nothing to read back`, 'ok'];
}
