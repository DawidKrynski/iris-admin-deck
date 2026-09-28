// Audit retention rules, kept pure (no DOM, no API) so they are unit-tested (tests/js/retention.test.mjs).
// IRIS takes audit ranges as "YYYY-MM-DD HH:MM:SS" in server time.

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} 00:00:00`;

/**
 * Cutoff for "older than `days` days": midnight `days` days before `today` ("YYYY-MM-DD", server date).
 * Whole days only and at least one, so a purge can never reach today's records.
 */
export function purgeCutoff(days, today) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) throw new Error('Enter a whole number of days, 1 or more.');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(today || ''));
  if (!m) throw new Error('The server date is not known.');
  return stamp(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] - n)));
}

/**
 * Refuses a purge that would leave no audit trail: the cutoff must lie before the newest record,
 * and only whole "older than" ranges are purged (no begin date, so never "everything" by accident).
 */
export function checkPurge(cutoff, newest) {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(cutoff || ''))) throw new Error('Invalid cutoff date.');
  // Without a readable newest record there is no proof that anything survives the purge.
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(String(newest || ''))) {
    throw new Error('The newest audit record could not be read; nothing is purged without it.');
  }
  if (String(cutoff) >= String(newest).slice(0, 19)) {
    throw new Error(`The cutoff ${cutoff} is not before the newest record (${newest}); that would purge the whole trail.`);
  }
  return { BeginDateTime: '', EndDateTime: cutoff };
}

/**
 * Audit records of a /v2/security/audit/records reply: the rows themselves, {Result: [...]},
 * {Result: {Records: [...]}}, or a finished background task carrying one of those. Throws for a
 * task that failed, was cancelled or has not finished, and for any other shape — so a failed
 * query can never be counted as "no records".
 */
export function auditRows(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') throw new Error('The audit query returned no result.');
  const task = result.GUID || result.Id || result.id;
  if (task) {
    const state = String(result.State || '');
    if (/fail|error|cancel|abort/i.test(state)) throw new Error(result.FailureReason || `Audit query ${state}`);
    if (!/finish|complete/i.test(state)) throw new Error(`Audit query did not finish (${state || 'no state'})`);
  }
  if (Array.isArray(result.Result)) return result.Result;
  if (result.Result && Array.isArray(result.Result.Records)) return result.Result.Records;
  throw new Error('The audit query returned an unexpected result.');
}

/** "1 234" / "at least 50 000" for a count read with a row cap. */
export const countLabel = (n, cap) => (n >= cap ? `at least ${n.toLocaleString('en-US')}` : n.toLocaleString('en-US'));
