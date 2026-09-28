// External language server settings, kept pure (no DOM, no API) so they are unit-tested (tests/js/extlang.test.mjs).
// PUT /v2/ext-lang-server takes the type-specific settings nested in `Custom` (Config.Gateways).

export const TYPES = ['Python', 'Java', '.NET', 'JDBC', 'ODBC', 'XSLT', 'ML', 'R', 'Remote'];
const JAVA = ['JavaHome', 'ClassPath', 'JVMArgs'];
const CUSTOM = {
  Java: JAVA,
  XSLT: JAVA,
  JDBC: JAVA,
  ML: JAVA,
  R: JAVA,
  '.NET': ['DotNetVersion', 'FilePath', 'Exec32'],
  Python: ['PythonPath', 'PythonOptions'],
  Remote: ['Address'],
  ODBC: [],
};

export const LABELS = {
  JavaHome: 'Java home',
  ClassPath: 'Class path',
  JVMArgs: 'JVM arguments',
  DotNetVersion: '.NET version',
  FilePath: 'Gateway executable path',
  Exec32: 'Run as 32-bit',
  PythonPath: 'Python executable path',
  PythonOptions: 'Python options',
  Address: 'Remote address',
};

/** Type-specific (Custom) setting names for a server type. */
export const customKeys = (type) => CUSTOM[type] || [];

/** Built-in servers (named %…) ship with IRIS: they may be started, stopped and edited, not deleted. */
export const builtIn = (name) => String(name || '').startsWith('%');

/** Flat form object of a server: Custom settings lifted next to the common ones. */
export function flatten(server) {
  const { Custom, ...rest } = server || {};
  return {
    ...rest,
    ...Object.fromEntries(customKeys(rest.Type).map((k) => [k, Custom?.[k] ?? (k === 'Exec32' ? false : '')])),
  };
}

/**
 * PUT body from a flat form value. With `original` (the server as read) only changed settings are sent;
 * a changed Custom setting sends the whole Custom object so the read-back compares like with like.
 */
export function serverBody(values, original) {
  const type = values.Type || original?.Type;
  const keys = customKeys(type);
  const common = Object.fromEntries(Object.entries(values).filter(([k]) => !keys.includes(k)));
  const custom = {
    ...(original?.Custom || {}),
    ...Object.fromEntries(keys.filter((k) => k in values).map((k) => [k, values[k]])),
  };
  if (!original) return { ...common, Type: type, ...(keys.length ? { Custom: custom } : {}) };
  const same = (a, b) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '');
  const out = Object.fromEntries(Object.entries(common).filter(([k, v]) => !same(v, original[k])));
  if (keys.some((k) => k in values && !same(values[k], original.Custom?.[k]))) out.Custom = custom;
  // IRIS 2026.2 refuses an update without Type (ERROR #40301), so a real change always carries it.
  return Object.keys(out).length ? { ...out, Type: type } : out;
}
