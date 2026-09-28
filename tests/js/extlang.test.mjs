// Unit tests for web/js/extlang.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customKeys, builtIn, flatten, serverBody } from '../../web/js/extlang.js';

// As GET /v2/ext-lang-server returns it (IRIS 2026.2).
const python = {
  BindToIPAddress: '127.0.0.1',
  ConnectionTimeout: 5,
  Port: 53472,
  Resource: '%Gateway_Object',
  Type: 'Python',
  UseSharedMemory: false,
  Custom: { PythonOptions: '', PythonPath: '' },
};

test('customKeys follows the server type', () => {
  assert.deepEqual(customKeys('Python'), ['PythonPath', 'PythonOptions']);
  assert.deepEqual(customKeys('JDBC'), ['JavaHome', 'ClassPath', 'JVMArgs']);
  assert.deepEqual(customKeys('ODBC'), []);
  assert.deepEqual(customKeys('nope'), []);
});

test('built-in servers are the %-named ones', () => {
  assert.ok(builtIn('%Python Server'));
  assert.ok(!builtIn('My Python'));
});

test('flatten lifts Custom settings next to the common ones', () => {
  const flat = flatten(python);
  assert.equal(flat.PythonPath, '');
  assert.equal(flat.Port, 53472);
  assert.ok(!('Custom' in flat));
  assert.equal(flatten({ Type: '.NET' }).Exec32, false);
});

test('an edit sends only what changed, always with Type', () => {
  assert.deepEqual(serverBody(flatten(python), python), {});
  assert.deepEqual(serverBody({ ...flatten(python), Port: 53499 }, python), { Port: 53499, Type: 'Python' });
  // A changed Custom setting sends the whole Custom object.
  assert.deepEqual(serverBody({ ...flatten(python), PythonOptions: '-u' }, python), {
    Custom: { PythonOptions: '-u', PythonPath: '' },
    Type: 'Python',
  });
});

test('a new server nests the type-specific settings in Custom', () => {
  assert.deepEqual(serverBody({ Type: 'Python', Port: 53499, PythonPath: '/usr/bin/python3' }), {
    Type: 'Python',
    Port: 53499,
    Custom: { PythonPath: '/usr/bin/python3' },
  });
  assert.deepEqual(serverBody({ Type: 'ODBC', Port: 53998 }), { Type: 'ODBC', Port: 53998 });
});
