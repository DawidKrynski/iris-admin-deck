// Unit tests for web/js/retention.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purgeCutoff, checkPurge, countLabel, auditRows } from '../../web/js/retention.js';

test('purgeCutoff counts whole days back from the server date, across month and year ends', () => {
  assert.equal(purgeCutoff(90, '2026-09-27 22:46:29.226'), '2026-06-29 00:00:00');
  assert.equal(purgeCutoff('1', '2026-03-01'), '2026-02-28 00:00:00');
  assert.equal(purgeCutoff(1, '2027-01-01 00:00:00'), '2026-12-31 00:00:00');
});

test('purgeCutoff refuses 0, negative, fractional and missing values', () => {
  for (const days of [0, -5, 1.5, '', 'abc']) assert.throws(() => purgeCutoff(days, '2026-09-27'), /whole number/);
  assert.throws(() => purgeCutoff(30, ''), /server date/);
});

test('checkPurge only purges up to a cutoff before the newest record', () => {
  assert.deepEqual(checkPurge('2026-06-29 00:00:00', '2026-09-27 22:46:29.226'), { BeginDateTime: '', EndDateTime: '2026-06-29 00:00:00' });
  assert.throws(() => checkPurge('2026-09-28 00:00:00', '2026-09-27 22:46:29.226'), /whole trail/);
  assert.throws(() => checkPurge('', '2026-09-27'), /Invalid/);
  assert.throws(() => checkPurge('2026-09-01', '2026-09-27'), /Invalid/);
});

test('checkPurge refuses a purge without a readable newest record', () => {
  for (const newest of ['', null, undefined, '—', '2026-09']) {
    assert.throws(() => checkPurge('2026-06-29 00:00:00', newest), /newest audit record could not be read/);
  }
});

test('purgeCutoff needs the server date, not a missing one', () => {
  assert.throws(() => purgeCutoff(30, undefined), /server date/);
  assert.equal(purgeCutoff(30, '2026-09-28 10:00:00'), '2026-08-29 00:00:00');
});

test('auditRows reads the reply shapes of a successful query', () => {
  const rows = [{ AuditIndex: 1 }];
  assert.deepEqual(auditRows(rows), rows);
  assert.deepEqual(auditRows({ Result: rows }), rows);
  assert.deepEqual(auditRows({ Result: { Records: rows } }), rows);
  assert.deepEqual(auditRows({ GUID: 'g', State: 'Finished', Result: rows }), rows);
  assert.deepEqual(auditRows({ Id: 'g', State: 'Completed', Result: [] }), [], 'a finished task may find nothing');
});

test('auditRows throws for failed, cancelled, unfinished and malformed results (never "no records")', () => {
  assert.throws(() => auditRows({ GUID: 'g', State: 'Failed', FailureReason: 'disk full', Result: [] }), /disk full/);
  assert.throws(() => auditRows({ GUID: 'g', State: 'Cancelled', Result: [] }), /Cancelled/);
  assert.throws(() => auditRows({ GUID: 'g', State: 'Error' }), /Error/);
  assert.throws(() => auditRows({ GUID: 'g', State: 'Running', Result: [] }), /did not finish/);
  assert.throws(() => auditRows({ GUID: 'g', State: 'Finished' }), /unexpected/);
  assert.throws(() => auditRows({ Result: 'oops' }), /unexpected/);
  assert.throws(() => auditRows({}), /unexpected/);
  assert.throws(() => auditRows(null), /no result/);
});

test('countLabel marks capped counts', () => {
  assert.equal(countLabel(1234, 10000), '1,234');
  assert.equal(countLabel(10000, 10000), 'at least 10,000');
});
