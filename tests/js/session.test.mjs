import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSchedule, IDLE_MS } from '../../web/js/session.js';

test('refresh before admin and extension access tokens expire', () => {
  assert.deepEqual(sessionSchedule(60, 1000, 1000), { expired: false, delay: 50000 });
  assert.equal(sessionSchedule(300, 1000, 1000).delay, 290000);
});
test('expired and nearly expired tokens have bounded delays', () => {
  for (const seconds of [-900, 0, 9, 10]) assert.equal(sessionSchedule(seconds, 0, 0).delay, 1000);
});
test('idle deadline wins over token expiry and cannot be revived after sleep', () => {
  assert.equal(sessionSchedule(300, 0, IDLE_MS - 500).delay, 500);
  for (const now of [IDLE_MS, IDLE_MS + 90000]) assert.deepEqual(sessionSchedule(300, 0, now), { expired: true, delay: 0 });
  assert.equal(sessionSchedule(60, IDLE_MS - 1, IDLE_MS).expired, false);
});
test('unreadable JWT expiry still enforces inactivity', () => {
  for (const expiry of [null, undefined, NaN, Infinity]) assert.equal(sessionSchedule(expiry, 0, 1).delay, IDLE_MS - 1);
});
