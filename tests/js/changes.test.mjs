// Unit tests for web/js/changes.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactPath, redactText, changeCall, outcomeOf, changeRecord, openChange, closeChange, outcomeKind, changesCsv, MAX_CALLS, MAX_DETAILS } from '../../web/js/changes.js';
import { StaleError } from '../../web/js/verify.js';

test('redactPath hides password, secret and token values in the query string only', () => {
  assert.equal(redactPath('/api/admin/v2/web-app?name=%2Fcsp%2Fx'), '/api/admin/v2/web-app?name=%2Fcsp%2Fx');
  assert.equal(redactPath('/x?user=a&Password=hunter2&ClientSecret=s&access_token=t&n=1'),
    '/x?user=a&Password=***&ClientSecret=***&access_token=***&n=1');
  assert.equal(redactPath('/v2/security/token-settings'), '/v2/security/token-settings');
  assert.equal(redactPath('/x?%70assword=a'), '/x?%70assword=***');
});

test('changeCall keeps writes, strips the proxy prefix and skips reads, record queries and the log itself', () => {
  assert.deepEqual(changeCall({ method: 'PUT', url: '/demo/api/admin/v2/web-app?name=%2Fcsp%2Fx' }, '/demo'),
    { method: 'PUT', path: '/api/admin/v2/web-app?name=%2Fcsp%2Fx' });
  assert.deepEqual(changeCall({ method: 'delete', url: 'http://h:1/api/admin/v2/task?id=5&token=abc' }),
    { method: 'DELETE', path: '/api/admin/v2/task?id=5&token=***' });
  assert.equal(changeCall({ method: 'GET', url: '/api/admin/v2/web-app' }), null);
  assert.equal(changeCall({ method: 'POST', url: '/api/admin/v2/security/audit/records?maxRows=5' }), null);
  assert.equal(changeCall({ method: 'POST', url: '/api/admin/v2/journal/file/records' }), null);
  assert.equal(changeCall({ method: 'POST', url: '/admindeck/api/changes' }), null);
  assert.equal(changeCall({ method: 'POST', url: '/api/admin/login' }), null);
});

test('outcomeOf reports the verification status, and refused or failed for errors', () => {
  assert.deepEqual(outcomeOf({ status: 'verified', mismatched: [] }), { outcome: 'verified', details: '' });
  assert.deepEqual(outcomeOf({ status: 'not-reflected', mismatched: ['Description', 'Enabled'] }), { outcome: 'not-reflected', details: 'Description, Enabled' });
  assert.deepEqual(outcomeOf({ status: 'partly-verified', mismatched: [], unchecked: ['Password'] }), { outcome: 'partly-verified', details: 'not returned by the API: Password' });
  assert.deepEqual(outcomeOf({ status: 'read-failed', mismatched: [], error: new Error('HTTP 500') }), { outcome: 'read-failed', details: 'HTTP 500' });
  assert.equal(outcomeOf(null, new StaleError(['Description'], {})).outcome, 'refused');
  assert.deepEqual(outcomeOf(null, new Error('ApplicationDoesNotExist')), { outcome: 'failed', details: 'ApplicationDoesNotExist' });
});

test('changeRecord caps calls and details and never carries a body', () => {
  const calls = Array.from({ length: 15 }, (_, i) => ({ method: 'PUT', path: `/x/${i}?secret=s`, body: { Password: 'p' } }));
  const r = changeRecord('Application saved', calls, { outcome: 'verified', details: 'x'.repeat(900) });
  assert.equal(r.calls.length, MAX_CALLS);
  assert.deepEqual(r.calls[0], { method: 'PUT', path: '/x/0?secret=***' });
  assert.equal(r.details.length, MAX_DETAILS);
  assert.ok(!JSON.stringify(r).includes('Password'));
});

test('outcomeKind colours outcomes like the toasts', () => {
  assert.equal(outcomeKind('verified'), 'ok');
  assert.equal(outcomeKind('partly-verified'), 'ok');
  assert.equal(outcomeKind('not-reflected'), 'warn');
  assert.equal(outcomeKind('refused'), 'warn');
  assert.equal(outcomeKind('failed'), 'err');
  assert.equal(outcomeKind('unverified'), 'muted');
});

test('the CSV export quotes what needs quoting and joins the calls', () => {
  const csv = changesCsv([{ time: '2026-09-28 10:00:00', user: 'SuperUser', what: 'Role saved, "reports"', outcome: 'verified',
    calls: [{ method: 'PUT', path: '/api/admin/v2/security/role?name=r' }, { method: 'DELETE', path: '/x' }] }]);
  const [head, row] = csv.trim().split('\r\n');
  assert.equal(head, 'time,user,what,outcome,details,calls');
  assert.equal(row, '2026-09-28 10:00:00,SuperUser,"Role saved, ""reports""",verified,,PUT /api/admin/v2/security/role?name=r; DELETE /x');
});

test('free text in what and details is redacted like a query string', () => {
  assert.equal(redactText('POST /custom/update?token=SECRET&n=1'), 'POST /custom/update?token=***&n=1');
  assert.equal(redactText('failed: ClientSecret=abc, password=p w'), 'failed: ClientSecret=***, password=*** w');
  assert.equal(redactText('Role saved, a=b'), 'Role saved, a=b');
  const r = changeRecord('POST /custom/update?token=SECRET', [], { outcome: 'failed', details: 'HTTP 500 for ?api_token=T' });
  assert.equal(r.what, 'POST /custom/update?token=***');
  assert.equal(r.details, 'HTTP 500 for ?api_token=***');
});

test('only POSTs to the known read endpoints count as reads; other record paths and methods are changes', () => {
  assert.equal(changeCall({ method: 'POST', url: '/api/admin/v2/database-dir/info?dir=%2Fx' }), null);
  assert.deepEqual(changeCall({ method: 'DELETE', url: '/custom/records' }), { method: 'DELETE', path: '/custom/records' });
  assert.deepEqual(changeCall({ method: 'POST', url: '/custom/records' }), { method: 'POST', path: '/custom/records' });
  assert.deepEqual(changeCall({ method: 'DELETE', url: '/api/admin/v2/security/audit/records' }), { method: 'DELETE', path: '/api/admin/v2/security/audit/records' });
});

test('CSV cells that a spreadsheet would run as a formula are kept as text', () => {
  const csv = changesCsv([{ time: 't', user: '=cmd', what: '+1', outcome: '-2', details: '@SUM(A1)', calls: [] },
    { time: 't', user: '\tx', what: '\rx', outcome: 'ok', details: 'a=b', calls: [] }]);
  const [, first, second] = csv.split('\r\n');
  assert.equal(first, "t,'=cmd,'+1,'-2,'@SUM(A1),");
  assert.equal(second, `t,'\tx,"'\rx",ok,a=b,`);
});

test('nesting is per operation: a change finishing meanwhile does not hide another one', () => {
  const a = openChange(); const b = openChange();
  a.calls.push({ method: 'PUT', path: '/a' });
  assert.equal(closeChange(b, 'B', { outcome: 'verified' }).what, 'B');
  const rec = closeChange(a, 'A', { outcome: 'unverified' });
  assert.deepEqual([rec.what, rec.calls], ['A', [{ method: 'PUT', path: '/a' }]], 'A still recorded, with its own calls');
  assert.equal(closeChange(a, 'A', { outcome: 'unverified' }), null, 'recorded once');
  const parent = openChange(); const child = openChange(parent);
  assert.ok(closeChange(child, 'child', { outcome: 'verified' }));
  assert.equal(closeChange(parent, 'parent', { outcome: 'unverified' }), null, 'the nested change already recorded it');
  assert.equal(closeChange(openChange(), 'read', { outcome: 'unverified' }, { always: false }), null, 'nothing written');
  assert.ok(closeChange(openChange(), 'stale', { outcome: 'refused' }, { always: false }), 'a refused edit is recorded');
});
