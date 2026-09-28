// Journal explorer helpers (pure, no DOM): request parameters and client-side conditions for journal records.

// The records endpoint matches on a single column (matchColumnName/matchOperator/matchValue); the first filled
// condition in this order is sent to IRIS, the others narrow the page it returns.
export const JOURNAL_FILTERS = [
  { key: 'global', column: 'GlobalNode', operator: '[', label: 'Global contains' },
  { key: 'pid', column: 'ProcessID', operator: '=', label: 'Process ID' },
  { key: 'database', column: 'DatabaseName', operator: '[', label: 'Database contains' },
  { key: 'type', column: 'TypeName', operator: '=', label: 'Type' },
  { key: 'from', column: 'TimeStamp', operator: '>=', label: 'From' },
  { key: 'to', column: 'TimeStamp', operator: '<=', label: 'Until' },
];
// TypeName values as IRIS reports them (matched exactly, case-sensitive).
export const RECORD_TYPES = ['SET', 'KILL', 'ZKILL', 'KILLdes', 'BitSET', 'BeginTrans', 'CommitTrans'];
export const PAGE_SIZE = 200;

// '^Orders("x")' and 'Orders("x")' find the same records: IRIS stores the global reference with the caret.
export function globalRef(value) {
  const v = String(value ?? '').trim();
  return v && !v.startsWith('^') ? `^${v}` : v;
}

// '2026-09-28T10:15' (datetime-local) -> '2026-09-28 10:15:00', the journal's own TimeStamp format.
export function journalTime(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  const [date, time = '00:00'] = v.split(/[T ]/);
  return `${date} ${time.length === 5 ? `${time}:00` : time}`;
}

/** Filled filter conditions, normalised, in JOURNAL_FILTERS order. */
export function conditions(filters = {}) {
  return JOURNAL_FILTERS.map((f) => {
    let value = String(filters[f.key] ?? '').trim();
    if (f.key === 'global') value = globalRef(value);
    if (f.key === 'from' || f.key === 'to') value = journalTime(value);
    return value ? { ...f, value } : null;
  }).filter(Boolean);
}

/**
 * Query string of POST /v2/journal/file/records: newest first, one page, first condition matched by IRIS.
 * IRIS 2026.2 returns only half of maxRows (rounded up: 10 -> 5, 200 -> 100), so a page asks for twice its size;
 * a page is full, and older records may follow, when it holds at least pageSize rows.
 */
export function recordsQuery(file, filters = {}, { offset, pageSize = PAGE_SIZE } = {}) {
  const [first] = conditions(filters);
  return {
    file,
    reverse: 1,
    maxRows: pageSize * 2,
    ...(offset ? { initialOffset: offset } : {}),
    ...(first ? { matchColumnName: first.column, matchOperator: first.operator, matchValue: first.value } : {}),
  };
}

// Same semantics as IRIS: '[' is a case-sensitive "contains".
function test(row, c) {
  const actual = String(row[c.column] ?? '');
  switch (c.operator) {
    case '[':
      return actual.includes(c.value);
    case '>=':
      return actual >= c.value;
    case '<=':
      return actual <= c.value;
    default:
      return actual === c.value;
  }
}

// Every records request (and any other background call of the API) is a task that IRIS journals in transactions
// (^Api.Admin.Util.AsyncTask* in IRISLOCALDATA): without hiding them and the bare BeginTrans/CommitTrans markers
// around them, the newest records are mostly the explorer's own reads.
export const isOwnTask = (row) =>
  /^\^Api\.Admin\.Util\.AsyncTask/.test(String(row.GlobalNode || '')) ||
  (/^(?:Begin|Commit)Trans$/.test(String(row.TypeName || '')) && !row.GlobalNode);

/** Rows of a returned page that also meet the conditions IRIS did not match (all but the first). */
export function refine(rows, filters = {}, { hideOwn = false } = {}) {
  const rest = conditions(filters).slice(1);
  return (Array.isArray(rows) ? rows : []).filter((r) => !(hideOwn && isOwnTask(r)) && rest.every((c) => test(r, c)));
}

/** Which values a SET/KILL record really carries: the new value for sets, the old one only inside a transaction. */
export function recordValues(rec) {
  const sk = rec?.SetKill || {};
  const set = /SET/i.test(String(rec?.TypeName || ''));
  const count = Number(sk.NumberOfValues ?? 0);
  return {
    hasNew: set && count >= 1,
    hasOld: !!rec?.InTransaction && count > (set ? 1 : 0),
    newValue: sk.NewValue,
    oldValue: sk.OldValue,
  };
}

// Offset of the next (older) page: records come newest first, so it continues below the last address returned.
export const nextOffset = (rows) => (rows.length ? Math.min(...rows.map((r) => Number(r.Address))) : null);
