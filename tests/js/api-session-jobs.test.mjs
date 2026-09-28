import { test } from 'node:test';
import assert from 'node:assert/strict';
globalThis.location = { pathname: '/admindeck/index.html' };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { admin, ext, logout, jwtExpiresIn, waitAsync } = await import('../../web/js/api.js');
const { jobs } = await import('../../web/js/jobs.js');
const token = (exp) => `x.${btoa(JSON.stringify({ exp }))}.x`;
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });

test('JWT expiry reads base64url and rejects malformed claims', () => {
  assert.equal(jwtExpiresIn(token(60), 10000), 50);
  assert.equal(jwtExpiresIn('bad'), null);
  assert.equal(jwtExpiresIn(token('60')), null);
});
test('both clients refresh proactively; concurrent refresh shares one request; logout discards late tokens', async () => {
  try {
    for (const client of [admin, ext]) {
      client.setTokens({ access_token: token(Date.now() / 1000 + 2), refresh_token: 'refresh' });
      let calls = 0;
      let resolve;
      globalThis.fetch = () => {
        calls++;
        return new Promise((r) => {
          resolve = r;
        });
      };
      const keepAlive = client.keepAlive();
      const shared = client.refresh();
      assert.equal(calls, 1);
      resolve(response({ access_token: token(Date.now() / 1000 + 300), refresh_token: 'next' }));
      await Promise.all([keepAlive, shared]);
      assert.equal(client.tokens.refresh_token, 'next');
      const late = client.refresh();
      const finish = resolve;
      await client.logout();
      finish(response({ access_token: token(9999999999), refresh_token: 'late' }));
      await assert.rejects(late, /Signed out/);
      assert.equal(client.loggedIn, false);
    }
  } finally {
    globalThis.fetch = async () => response({});
    await logout();
  }
});
test('202 method/path fallback, polling progress, final state and monitoring errors', async () => {
  globalThis.fetch = async () => response({}, 202, { Location: '/v2/async-result?id=test-id' });
  const queued = await admin.post('/v2/example', {});
  const states = [{ State: 'Running', Message: 'Reading' }, { State: 'Finished' }];
  globalThis.fetch = async () => response({ result: states.shift() });
  const task = await waitAsync(queued.GUID, { interval: 0 });
  assert.equal(task.State, 'Finished');
  assert.equal(jobs.list()[0].label, 'POST /v2/example');
  assert.equal(jobs.list()[0].message, 'Reading');
  assert.notEqual(jobs.list()[0].ended, null);
  globalThis.fetch = async () => {
    throw new Error('Offline');
  };
  await assert.rejects(waitAsync('failed', { label: 'Audit copy' }), /Offline/);
  assert.equal(jobs.list().at(-1).state, 'Monitoring failed');
  jobs.clear();
});
