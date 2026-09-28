import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusSummary } from '../../web/js/status-summary.js';
const normal = [{ name: 'IRIS instance', level: 0 }];
test('failing checks override normal components', () => {
  assert.deepEqual(statusSummary(normal, { fail: 2, warn: 2 }), { text: '2 checks failing, 2 warnings', level: 'err', checksAttention: true });
});
test('warnings alone and singular counts', () => {
  assert.equal(statusSummary(normal, { warn: 1 }).text, '1 warning');
  assert.equal(statusSummary(normal, { fail: 1 }).text, '1 check failing');
});
test('component problems and checks are both represented', () => {
  const s = statusSummary([{ name: 'IRIS instance', level: 2 }], { warn: 2 });
  assert.equal(s.level, 'err'); assert.match(s.text, /2 warnings.*Attention needed: IRIS instance/);
});
test('unknown, loading and stale sources cannot conceal check failures', () => {
  assert.match(statusSummary(normal, null).text, /Checks unavailable or loading/);
  assert.match(statusSummary(normal, { unknown: 3 }).text, /3 checks not checked/);
  assert.match(statusSummary([], { fail: 2 }, 'Metrics unavailable').text, /2 checks failing.*Metrics unavailable/);
  assert.equal(statusSummary([], { fail: 2 }, 'Stale').level, 'err');
  assert.equal(statusSummary([], {}).level, 'none');
  assert.equal(statusSummary(normal, {}).text, 'All components normal');
});
