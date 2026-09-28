// Unit tests for the journal explorer helpers in web/js/journal.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  globalRef,
  journalTime,
  conditions,
  recordsQuery,
  refine,
  recordValues,
  nextOffset,
  PAGE_SIZE,
} from '../../web/js/journal.js';

test('globalRef adds the caret once', () => {
  assert.equal(globalRef('Orders'), '^Orders');
  assert.equal(globalRef(' ^Orders("x") '), '^Orders("x")');
  assert.equal(globalRef(''), '');
});

test('journalTime turns a datetime-local value into the journal format', () => {
  assert.equal(journalTime('2026-09-28T10:15'), '2026-09-28 10:15:00');
  assert.equal(journalTime('2026-09-28T10:15:30'), '2026-09-28 10:15:30');
  assert.equal(journalTime(''), '');
});

test('recordsQuery asks for the newest page and lets IRIS match the first condition', () => {
  assert.deepEqual(recordsQuery('/j/1'), { file: '/j/1', reverse: 1, maxRows: PAGE_SIZE * 2 });
  assert.deepEqual(recordsQuery('/j/1', { type: 'KILL', global: 'Orders' }, { offset: 500, pageSize: 50 }), {
    file: '/j/1',
    reverse: 1,
    maxRows: 100,
    initialOffset: 500,
    matchColumnName: 'GlobalNode',
    matchOperator: '[',
    matchValue: '^Orders',
  });
  assert.equal(conditions({ from: '2026-09-28T10:00', pid: ' 42 ' })[0].column, 'ProcessID');
});

test('refine applies the conditions IRIS did not match', () => {
  const rows = [
    { Address: 3, GlobalNode: '^A(1)', TypeName: 'SET', TimeStamp: '2026-09-28 10:00:00', DatabaseName: '/mgr/user/' },
    { Address: 2, GlobalNode: '^A(1)', TypeName: 'KILL', TimeStamp: '2026-09-28 09:00:00', DatabaseName: '/mgr/user/' },
    { Address: 1, GlobalNode: '^A(1)', TypeName: 'SET', TimeStamp: '2026-09-27 09:00:00', DatabaseName: '/mgr/app/' },
  ];
  assert.deepEqual(
    refine(rows, { global: 'A', type: 'SET' }).map((r) => r.Address),
    [3, 1],
  );
  assert.deepEqual(
    refine(rows, { global: 'A', from: '2026-09-28T00:00', database: 'user' }).map((r) => r.Address),
    [3, 2],
  );
  assert.deepEqual(
    refine(rows, { to: '2026-09-28T09:30' }).map((r) => r.Address),
    [3, 2, 1],
  ); // first condition: IRIS's job
  assert.deepEqual(refine(null, {}), []);
});

test('nextOffset continues below the oldest record of a page', () => {
  assert.equal(nextOffset([{ Address: 900 }, { Address: 700 }, { Address: '800' }]), 700);
  assert.equal(nextOffset([]), null);
});

test("refine matches case-sensitively like IRIS and can hide the explorer's own task records", () => {
  const rows = [
    { Address: 2, GlobalNode: '^Api.Admin.Util.AsyncTaskD("1","ListTask")', DatabaseName: '/mgr/irislocaldata/' },
    { Address: 1, GlobalNode: '^ZJRNTEST(1)', DatabaseName: '/mgr/user/' },
  ];
  assert.deepEqual(refine(rows, { pid: 1, database: 'USER' }), []);
  const marker = { Address: 0, TypeName: 'CommitTrans', GlobalNode: '' };
  assert.deepEqual(
    refine([...rows, marker], {}, { hideOwn: true }).map((r) => r.Address),
    [1],
  );
  assert.equal(refine([...rows, marker], {}).length, 3);
});

test('recordValues knows which values a record carries', () => {
  const rec = (TypeName, InTransaction, NumberOfValues) => ({
    TypeName,
    InTransaction,
    SetKill: { NumberOfValues, NewValue: 'n', OldValue: 'o' },
  });
  assert.deepEqual(recordValues(rec('SET', false, 1)), { hasNew: true, hasOld: false, newValue: 'n', oldValue: 'o' });
  assert.equal(recordValues(rec('SET', true, 2)).hasOld, true);
  assert.equal(recordValues(rec('SET', true, 1)).hasOld, false); // the node had no value before
  assert.deepEqual(recordValues(rec('KILL', false, 0)), { hasNew: false, hasOld: false, newValue: 'n', oldValue: 'o' });
  assert.equal(recordValues(rec('KILL', true, 1)).hasOld, true);
  assert.deepEqual(recordValues({}), { hasNew: false, hasOld: false, newValue: undefined, oldValue: undefined });
});
