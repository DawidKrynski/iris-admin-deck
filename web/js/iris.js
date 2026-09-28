// IRIS codes and strings the API returns raw: authentication bitmask, daemon routines, $ZVERSION,
// mirror member type, license use and the Prometheus text of /api/monitor/metrics.

// Security.Applications / Security.Services AutheEnabled bits (%sySecurityMacros.inc, IRIS 2026.2).
export const AUTHE = [
  [1, 'Kerberos credentials cache'],
  [2, 'Kerberos prompt'],
  [4, 'Kerberos'],
  [8, 'Kerberos keytab'],
  [16, 'Operating system'],
  [32, 'Password'],
  [64, 'Unauthenticated'],
  [128, 'Kerberos (connection)'],
  [256, 'Kerberos with encryption'],
  [512, 'Kerberos with packet integrity'],
  [2048, 'LDAP'],
  [4096, 'LDAP cache'],
  [8192, 'Delegated'],
  [16384, 'Login cookie'],
  [32768, 'Kerberos delegated'],
  [65536, 'OS delegated'],
  [131072, 'OS LDAP'],
  [262144, 'X.509'],
  [524288, 'TLS'],
  [1048576, 'Two-factor SMS'],
  [2097152, 'Two-factor TOTP'],
  [16777216, 'Always try delegated'],
  [33554432, 'Mutual TLS'],
  [67108864, 'OAuth 2.0'],
];

/** 96 -> ['Password', 'Unauthenticated']; unknown bits come back as numbers. */
export function authMethods(bits) {
  const n = Number(bits) || 0;
  const names = AUTHE.filter(([bit]) => n & bit).map(([, name]) => name);
  const rest = n & ~AUTHE.reduce((all, [bit]) => all | bit, 0);
  return rest ? [...names, `bit ${rest}`] : names;
}

// System daemons (routine name as /v2/processes reports it). IRIS refuses to suspend or terminate them.
const DAEMONS = {
  CONTROL: 'control process, starts and watches the other daemons',
  WRTDMN: 'write daemon, writes changed database blocks to disk',
  AUXWD: 'auxiliary write daemon',
  GARCOL: 'garbage collector, frees blocks after large KILLs',
  JRNDMN: 'journal daemon, writes the journal buffer to the journal file',
  EXPDMN: 'expansion daemon, grows database files',
  CLNDMN: 'clean daemon, cleans up after processes that died',
  LMFMON: 'license monitor',
  '%SYS.SERVER': 'superserver',
};

/** Why a process has no Suspend/Terminate: '' for ordinary processes. */
export function systemProcess(p) {
  // What IRIS says wins: a user process may well run a routine called Control.
  if (p.CanBeSuspended === true || p.CanBeTerminated === true) return '';
  if (p.Username || p.UserName) return '';
  const routine = String(p.Routine || '').toUpperCase();
  if (DAEMONS[routine]) return `${routine}: ${DAEMONS[routine]}`;
  return p.CanBeSuspended === false && p.CanBeTerminated === false ? 'System process' : '';
}

// Shipped read-only: a read-only mount of these is the normal state, not a problem.
export const READ_ONLY_BY_DEFAULT = new Set(['IRISLIB', 'ENSLIB', 'HSLIB']);

/** "IRIS for UNIX (Ubuntu ...) 2026.2 (Build 221U) Fri Jun 26 2026" -> "IRIS 2026.2 · build 221U" */
export function versionLabel(v) {
  const m = /^(\S+).*?\)\s+([\d.]+)\s+\(Build ([^)]+)\)/.exec(v || '');
  return m ? `${m[1]} ${m[2]} · build ${m[3]}` : v || 'IRIS';
}

/** "IRIS for UNIX (Ubuntu Server LTS for x86-64 Containers) 2026.2 ..." -> "Ubuntu Server LTS for x86-64 Containers" */
export function platformLabel(v) {
  const m = /\(([^)]+)\)/.exec(v || '');
  return m ? m[1] : '';
}

// iris_mirror_member_type values (the metric's HELP text).
const MIRROR = {
  1: 'indeterminate',
  2: 'not a member',
  3: 'failover member',
  4: 'async member',
  5: 'disaster recovery async',
  6: 'read-only reporting async',
  7: 'read-write reporting async',
};
export const mirrorLabel = (type) => MIRROR[type] || null;

/** Dashboard LicenseUse is a percentage of LicenseLimit units: 13 % of 8 -> 1 unit. */
export const licenseUnits = (pct, limit) => Math.round(((Number(pct) || 0) * (Number(limit) || 0)) / 100);

/** Prometheus text format -> { metric: [{labels, value}] } (comments and blank lines skipped). */
export function parseMetrics(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = /^([a-zA-Z_:][\w:]*)(?:\{([^}]*)\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const labels = Object.fromEntries([...(m[2] || '').matchAll(/(\w+)="([^"]*)"/g)].map((x) => [x[1], x[2]]));
    (out[m[1]] ||= []).push({ labels, value: Number(m[3]) });
  }
  return out;
}

/** { <label value>: value } of one metric, e.g. byLabel(metrics, 'iris_db_free_space') -> { USER: 4.4 } */
export function byLabel(metrics, name, label = 'id') {
  return Object.fromEntries((metrics[name] || []).map((s) => [s.labels[label], s.value]));
}
