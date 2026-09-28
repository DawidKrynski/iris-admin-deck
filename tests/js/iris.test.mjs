import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  authMethods,
  systemProcess,
  versionLabel,
  platformLabel,
  mirrorLabel,
  licenseUnits,
  parseMetrics,
  byLabel,
} from '../../web/js/iris.js';

test('AutheEnabled bitmask decodes to method names', () => {
  assert.deepEqual(authMethods(64), ['Unauthenticated']);
  assert.deepEqual(authMethods(96), ['Password', 'Unauthenticated']);
  assert.deepEqual(authMethods(8192 | 16384), ['Delegated', 'Login cookie']);
  assert.deepEqual(authMethods(0), []);
  assert.deepEqual(authMethods(1024), ['bit 1024']); // AutheSystem: not a web application method
});

test('system daemons are named, user processes are not', () => {
  assert.match(systemProcess({ Routine: 'WRTDMN', Username: '' }), /^WRTDMN: write daemon/);
  assert.match(systemProcess({ Routine: '%SYS.SERVER' }), /superserver/);
  assert.equal(
    systemProcess({ Routine: 'MONITOR', Username: '', CanBeSuspended: false, CanBeTerminated: false }),
    'System process',
  );
  assert.equal(systemProcess({ Routine: 'MyApp.Job', Username: 'app', CanBeSuspended: true }), '');
  assert.equal(
    systemProcess({ Routine: '%SYS.WorkQueueMgr', Username: '', CanBeSuspended: true, CanBeTerminated: false }),
    '',
  );
  // A user's own routine may share a daemon's name; IRIS's flags and the user name decide.
  assert.equal(systemProcess({ Routine: 'Control', Username: 'app', CanBeSuspended: true, CanBeTerminated: true }), '');
  assert.equal(systemProcess({ Routine: 'CONTROL', Username: 'app' }), '');
});

test('$ZVERSION labels', () => {
  const v = 'IRIS for UNIX (Ubuntu Server LTS for x86-64 Containers) 2026.2 (Build 221U) Fri Jun 26 2026 09:58:52 EDT';
  assert.equal(versionLabel(v), 'IRIS 2026.2 · build 221U');
  assert.equal(platformLabel(v), 'Ubuntu Server LTS for x86-64 Containers');
  assert.equal(versionLabel(''), 'IRIS');
});

test('mirror member type and license units', () => {
  assert.equal(mirrorLabel(2), 'not a member');
  assert.equal(mirrorLabel(undefined), null);
  assert.equal(licenseUnits(13, 8), 1);
  assert.equal(licenseUnits('', 8), 0);
});

test('Prometheus text is parsed with labels', () => {
  const m = parseMetrics(
    '# HELP iris_db_free_space Free space\n# TYPE iris_db_free_space gauge\n' +
      'iris_db_free_space{id="USER"} 4.4\niris_db_free_space{id="IRISSYS"} .3\n' +
      'iris_db_size_mb{id="IPM",dir="/usr/irissys/mgr/zpm/"} 17\niris_mirror_member_type 2\n',
  );
  assert.deepEqual(byLabel(m, 'iris_db_free_space'), { USER: 4.4, IRISSYS: 0.3 });
  assert.deepEqual(m.iris_db_size_mb[0].labels, { id: 'IPM', dir: '/usr/irissys/mgr/zpm/' });
  assert.equal(m.iris_mirror_member_type[0].value, 2);
  assert.deepEqual(byLabel(m, 'missing'), {});
});
