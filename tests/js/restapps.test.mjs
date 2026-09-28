// Unit tests for the "REST APIs on this instance" helpers (web/js/restapps.js) and the JWT expiry and
// curl helpers of web/js/api.js — run with: node --test tests/js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeApps,
  urlMapPath,
  pathParams,
  fillPath,
  isPattern,
  routesFromUrlMap,
  routesFromSpec,
  parseQuery,
  joinPath,
  insideApp,
  responseText,
  MAX_BODY,
} from '../../web/js/restapps.js';

// api.js reads location and sessionStorage when it loads.
globalThis.location = { pathname: '/admindeck/index.html', origin: 'http://x' };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const { jwtExpiresIn, curl } = await import('../../web/js/api.js');

test('mergeApps keeps web apps with a dispatch class and adds the /api/mgmnt list', () => {
  const web = [
    { Name: '/csp/user', Namespace: 'USER', DispatchClass: '', Enabled: true },
    { Name: '/admindeck/api', Namespace: 'USER', DispatchClass: 'AdminDeck.REST.Dispatch', Enabled: true },
    { Name: '/api/iam', Namespace: '%SYS', DispatchClass: '%Api.IAM.v1.disp', Enabled: false },
  ];
  const listed = [
    {
      name: '/api/iam',
      dispatchClass: '%Api.IAM.v1.disp',
      namespace: '%SYS',
      swaggerSpec: '/api/mgmnt/v2/%25SYS/%25Api.IAM.v1',
      enabled: false,
    },
    {
      name: '/api/monitor',
      dispatchClass: '%Api.Monitor',
      namespace: '%SYS',
      swaggerSpec: '/api/mgmnt/v1/%25SYS/spec/api/monitor',
      enabled: true,
    },
  ];
  const apps = mergeApps(web, listed);
  assert.deepEqual(
    apps.map((a) => a.name),
    ['/admindeck/api', '/api/iam', '/api/monitor'],
    'sorted, no app without a class',
  );
  assert.equal(apps[0].listed, false, 'only in /v2/web-apps');
  assert.deepEqual(
    [apps[1].specFirst, apps[1].enabled, apps[1].listed],
    [true, false, true],
    'spec-first: served under /api/mgmnt/v2',
  );
  assert.deepEqual([apps[2].specFirst, apps[2].namespace], [false, '%SYS'], 'only in the extension list');
  assert.deepEqual(mergeApps(undefined, null), []);
});

test('UrlMap paths, placeholders and filling', () => {
  assert.equal(urlMapPath('/logs/:file/insights'), '/logs/{file}/insights');
  assert.equal(urlMapPath('/interop/:namespace/:action'), '/interop/{namespace}/{action}');
  assert.deepEqual(pathParams('/interop/{namespace}/{action}'), ['namespace', 'action']);
  assert.deepEqual(pathParams('/whoami'), []);
  assert.equal(
    fillPath('/logs/{file}', { file: 'messages.old 1/x' }),
    '/logs/messages.old%201%2Fx',
    'values are URL-encoded',
  );
  assert.throws(() => fillPath('/logs/{file}', { file: '  ' }), /file is required/);
  assert.ok(isPattern('/v1/(.*)'), 'regular expression');
  assert.ok(isPattern('/files/[^/]+'));
  assert.ok(!isPattern('/v1/%25SYS/docs'), 'an encoded value is not a pattern');
});

test('routesFromUrlMap turns extension rows into sorted routes', () => {
  const routes = routesFromUrlMap([
    { method: 'POST', url: '/logs/:file/index', call: 'IndexLog', class: 'AdminDeck.REST.Dispatch' },
    { method: 'get', url: '/whoami', call: 'WhoAmI', class: 'AdminDeck.REST.Dispatch' },
    { url: '/logs/:file', call: 'GetLog' },
  ]);
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.path}`),
    ['GET /logs/{file}', 'POST /logs/{file}/index', 'GET /whoami'],
  );
  assert.deepEqual(routes[0].params, [{ name: 'file', in: 'path', required: true, description: '' }]);
  assert.equal(routes[1].body, true, 'POST takes a body');
  assert.equal(routes[2].summary, 'AdminDeck.REST.Dispatch:WhoAmI');
  assert.deepEqual(routesFromUrlMap(null), []);
});

test('routesFromSpec reads OpenAPI 2.0 (with $ref and overrides) and 3.x', () => {
  const v2 = {
    swagger: '2.0',
    basePath: '/api/mgmnt',
    parameters: { ns: { name: 'namespace', in: 'path', required: true, type: 'string', description: 'Namespace' } },
    paths: {
      '/v2/{namespace}/{application}': {
        parameters: [{ $ref: '#/parameters/ns' }, { name: 'application', in: 'path', type: 'string' }],
        get: { operationId: 'GetApplication', parameters: [{ name: 'format', in: 'query', type: 'string' }] },
        post: { summary: 'Create', parameters: [{ name: 'spec', in: 'body', schema: { type: 'object' } }] },
      },
      '/': { get: { summary: 'List' } },
    },
  };
  const routes = routesFromSpec(v2);
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.path}`),
    ['GET /', 'GET /v2/{namespace}/{application}', 'POST /v2/{namespace}/{application}'],
  );
  const get = routes[1];
  assert.equal(get.summary, 'GetApplication', 'operationId when there is no summary');
  assert.deepEqual(
    get.params.map((p) => `${p.in}:${p.name}:${p.required}`),
    ['path:namespace:true', 'path:application:true', 'query:format:false'],
  );
  assert.equal(get.params[0].description, 'Namespace', '$ref resolved');
  assert.equal(get.body, false);
  assert.equal(routes[2].body, true, 'body parameter');
  assert.ok(!routes[2].params.some((p) => p.in === 'body'), 'the body is not a field');
  const v3 = {
    openapi: '3.0.0',
    paths: {
      '/items/{id}': {
        put: { requestBody: { content: {} }, parameters: [{ name: 'id', in: 'path', required: true }] },
      },
    },
  };
  assert.deepEqual(
    routesFromSpec(v3).map((r) => [r.method, r.body]),
    [['PUT', true]],
  );
  assert.deepEqual(routesFromSpec({}), []);
});

test('query and path joining', () => {
  assert.deepEqual(parseQuery('?a=1&b=two%20words'), { a: '1', b: 'two words' });
  assert.deepEqual(parseQuery(''), {});
  assert.equal(joinPath('/admindeck/api/', '/whoami'), '/admindeck/api/whoami');
  assert.equal(joinPath('/api/mgmnt', '/'), '/api/mgmnt/');
  assert.throws(() => joinPath('/admindeck/api', '/../../api/admin/v2/security/users'), /inside the application/);
  assert.throws(() => joinPath('/admindeck/api', '/x/%2e%2e/y'), /inside the application/);
});

test('Try it refuses paths the URL parser would turn into a traversal', () => {
  // Tabs and newlines are dropped by the URL parser, a backslash becomes a slash.
  assert.throws(
    () => joinPath('/custom', '/..\t/..\t/api/admin/v2/security/user'),
    /control characters or backslashes/,
  );
  assert.throws(() => joinPath('/custom', '/.\n./api/admin'), /control characters or backslashes/);
  assert.throws(() => joinPath('/custom', '/..\\..\\api/admin'), /control characters or backslashes/);
  assert.equal(
    new URL('/custom/..\t/..\t/api/admin/v2/security/user', 'http://x').pathname,
    '/api/admin/v2/security/user',
    'what fetch would send',
  );
  assert.ok(insideApp('/custom', '/custom/a/b?x=1'));
  assert.ok(insideApp('/custom/', '/custom'));
  assert.ok(!insideApp('/custom', '/custom/..\t/..\t/api/admin/v2/security/user'), 'checked after normalisation');
  assert.ok(!insideApp('/custom', '/customer/x'), 'a longer sibling name is outside');
  assert.ok(!insideApp('/custom', '//evil.example/custom/x', 'http://h'), 'another host is outside');
  assert.ok(insideApp('/p/custom', '/p/custom/x', 'http://h'), 'with a proxy prefix');
});

test('responseText shows status, headers and the body as text', () => {
  const json = responseText({
    status: 200,
    statusText: 'OK',
    headers: [['content-type', 'application/json']],
    body: '{"a":1}',
    ms: 12,
  });
  assert.equal(json, 'HTTP 200 OK · 12 ms\ncontent-type: application/json\n\n{\n  "a": 1\n}');
  const html = responseText({
    status: 404,
    headers: [['content-type', 'text/html']],
    body: '<html><b>Not found</b></html>',
  });
  assert.ok(html.endsWith('<html><b>Not found</b></html>'), 'HTML stays text, unchanged');
  assert.ok(responseText({ status: 401, headers: [], body: '' }).endsWith('(empty body)'));
  assert.ok(
    responseText({ status: 200, headers: [['content-type', 'application/json']], body: '{broken' }).endsWith('{broken'),
    'invalid JSON kept as sent',
  );
  assert.ok(responseText({ status: 0, headers: [], body: '' }).startsWith('Redirect (not followed)'));
  const long = responseText({ status: 200, headers: [], body: 'x'.repeat(MAX_BODY + 5) });
  assert.ok(long.endsWith('5 more characters not shown'));
});

test('jwtExpiresIn reads the exp claim; curl can sign in with -u', () => {
  const payload = Buffer.from(JSON.stringify({ exp: 1000, sub: 'SuperUser' })).toString('base64url');
  assert.equal(jwtExpiresIn(`h.${payload}.s`, 940_000), 60);
  assert.equal(jwtExpiresIn('not-a-jwt'), null);
  assert.equal(jwtExpiresIn(null), null);
  assert.equal(
    curl('GET', '/admindeck/api/whoami'),
    `curl -X GET -H "Authorization: Bearer $TOKEN" 'http://x/admindeck/api/whoami'`,
  );
  assert.equal(
    curl('GET', '/api/mgmnt/', undefined, { basic: true }),
    `curl -X GET -u "$IRIS_USER" 'http://x/api/mgmnt/'`,
  );
});
