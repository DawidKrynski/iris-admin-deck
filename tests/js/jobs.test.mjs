import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobs } from '../../web/js/jobs.js';
test('tracks progress, last message and completion without retaining results', () => {
  const jobs = createJobs(); let notifications = 0;
  jobs.subscribe(() => notifications++);
  const job = jobs.start('1', 'Integrity check');
  jobs.update(job, { State: 'Running', Console: ['Starting', 'Reading'] }, false);
  assert.equal(jobs.list()[0].message, 'Reading');
  assert.equal(jobs.list()[0].ended, null);
  jobs.update(job, { State: 'Failed', FailureReason: 'Read failed', Result: { data: 'large' } }, true);
  assert.equal(jobs.list()[0].state, 'Failed');
  assert.equal(jobs.list()[0].message, 'Read failed');
  assert.equal(typeof jobs.list()[0].ended, 'number');
  assert.equal(jobs.list()[0].Result, undefined);
  assert.equal(notifications, 3);
});
test('retains at most 20 finished jobs and all active jobs; clears across sessions', () => {
  const jobs = createJobs(); const active = jobs.start('active', 'Active');
  for (let i = 0; i < 25; i++) jobs.update(jobs.start(String(i), 'Test'), { State: 'Finished' }, true);
  assert.equal(jobs.list().length, 21);
  assert.equal(jobs.list()[0].id, 'active');
  assert.equal(jobs.list()[1].id, '5');
  jobs.clear(); jobs.update(active, { State: 'Finished' }, true);
  assert.deepEqual(jobs.list(), []);
});
test('opening an already tracked task does not count it twice', () => {
  const jobs = createJobs();
  const first = jobs.start('same', 'Integrity check');
  assert.equal(jobs.start('same', 'Task view'), first);
  assert.equal(jobs.list().length, 1);
  jobs.update(first, { State: 'Finished' }, true);
  jobs.update(first, { State: 'Running' }, false);
  assert.equal(jobs.list()[0].state, 'Finished');
});
