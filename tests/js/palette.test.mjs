// Unit tests for the command palette ranking — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';

// palette.js imports the DOM toolkit; the ranking function is pure, so load it with a minimal DOM stub.
globalThis.document = { addEventListener() {}, createElement: () => ({}) };
globalThis.location = { pathname: '/admindeck/index.html', origin: 'http://x' };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { score } = await import('../../web/js/palette.js');

test('exact beats prefix beats word start beats substring', () => {
  assert.ok(score('Tasks', 'tasks') > score('Task history', 'tasks'));
  assert.ok(score('Task history', 'task') > score('Purge Tasks', 'task'));
  assert.ok(score('Purge Tasks', 'task') > score('Subtasking', 'task'));
});

test('word boundaries include IRIS naming (%, /, _)', () => {
  assert.equal(score('%Admin_Secure', 'secure'), 60);
  assert.equal(score('/api/admin', 'admin'), 60);
});

test('no match scores zero and empty query matches everything', () => {
  assert.equal(score('Users', 'xyz'), 0);
  assert.equal(score('Users', ''), 1);
});
