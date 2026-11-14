import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { afterEach, beforeEach, test } from 'node:test';
import { connect, disconnect, loadApp, MakeError, runModule, runRpc, ValidationError } from './iml.mjs';
import { ALBUM_READ_ONLY, ALBUM_WRITABLE, CLIENT_ID, JPEG, ORIGIN, startLibrary } from './library.mjs';

const ASSET = '00000000-0000-4000-8000-000000000001';
const app = await loadApp();
const scenario = async (id) => JSON.parse(await readFile(new URL(`../scenarios/${id}.json`, import.meta.url), 'utf8'));
const fixtures = { jpeg: JPEG };
const hydrate = (value) =>
  value?.$fixture ? fixtures[value.$fixture] : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, entry?.$fixture ? fixtures[entry.$fixture] : entry]));

let library;
beforeEach(async () => (library = await startLibrary()));
afterEach(() => library.close());

const linked = (scopes = Object.keys(app.connection.scopes)) =>
  connect(app, { serverUrl: ORIGIN, frameleafClientId: CLIENT_ID }, { fetch: library.fetch, consent: library.consent, scopes });
const run = (state, id, parameters, extra = {}) => runModule(app, id, parameters, state, { fetch: library.fetch, ...extra });
const connectCalls = (from) => library.state.requests.slice(from).filter((request) => request.path.startsWith('/api/connect/'));

test('every module is complete, grouped once, scoped and has a test scenario', async () => {
  const ids = Object.keys(app.modules).sort();
  assert.deepEqual(ids, [
    'addAssetsToAlbum', 'addTags', 'createAlbum', 'downloadRendition', 'getAsset',
    'listAlbums', 'makeApiCall', 'searchAssets', 'uploadPhoto', 'watchEvents',
  ]);
  assert.deepEqual(app.groups.flatMap((group) => group.modules).sort(), ids);
  assert.deepEqual((await readdir(new URL('../scenarios/', import.meta.url))).sort(), ids.map((id) => `${id}.json`));
  for (const module of Object.values(app.modules)) {
    assert.ok(module.label && module.description, module.id);
    assert.ok(['trigger', 'action', 'search', 'universal'].includes(module.moduleType), module.id);
    assert.equal(module.scope.length, 1, `${module.id} asks for one minimum scope`);
    assert.ok(Object.hasOwn(app.connection.scopes, module.scope[0]), module.id);
    assert.ok(module.interface.length > 0, module.id);
  }
  assert.deepEqual(app.connection.scope, ['library:read']);
  assert.equal(app.connection.communication.authorize.qs.scope, "{{join(oauth.scope, ' ')}}");
  assert.doesNotMatch(JSON.stringify(app.connection.scopes), /download|boards|admin|delete/);
});

test('modules stay relative to /api/connect with only the base bearer header', () => {
  assert.equal(app.base.baseUrl, '{{connection.serverUrl}}/api/connect');
  assert.deepEqual(app.base.headers, { authorization: 'Bearer {{connection.accessToken}}' });
  for (const sanitized of ['request.headers.authorization', 'request.body', 'request.qs.q', 'response.body.url'])
    assert.ok(app.base.log.sanitize.includes(sanitized), sanitized);
  for (const module of Object.values(app.modules)) {
    for (const step of [module.communication].flat()) {
      assert.ok(step.url.startsWith('/') || step.url === '{{parameters.url}}', `${module.id} ${step.url}`);
      assert.doesNotMatch(step.url, /\.\.|https?:|\/\//, module.id);
      assert.equal(step.headers?.authorization, undefined, `${module.id} cannot override authorization`);
      for (const [, expression] of step.url.matchAll(/\{\{([^}]+)\}\}/g)) {
        if (expression.startsWith('temp.') || module.id === 'makeApiCall') continue;
        const name = /^encodeURL\(parameters\.(\w+)\)$/.exec(expression)?.[1];
        assert.ok(name, `${module.id} encodes ${expression}`);
        assert.match(module.parameters.find((spec) => spec.name === name).validate.pattern, /\[0-9a-f\]\{8\}/);
      }
    }
  }
  assert.ok(!app.modules.makeApiCall.parameters.some((spec) => /header/i.test(spec.name)), 'universal module sends no custom headers');
});

test('create and upload require a Source ID that becomes the request ID', () => {
  for (const id of ['createAlbum', 'uploadPhoto']) {
    const module = app.modules[id];
    assert.equal(module.parameters.find((spec) => spec.name === 'sourceId').required, true);
    const steps = [module.communication].flat();
    assert.ok(steps.every((step) => !step.body?.requestId || step.body.requestId === '{{parameters.sourceId}}'));
    assert.ok(steps.some((step) => step.body?.requestId === '{{parameters.sourceId}}'), id);
  }
});

for (const id of Object.keys(app.modules)) {
  test(`scenario: ${id}`, async () => {
    const plan = await scenario(id);
    const state = await linked(app.modules[id].scope);
    for (let n = 0; n < (plan.events ?? 0); n++)
      library.pushEvent('album.asset.added', `00000000-0000-4000-8000-00000000000${n + 1}`, { albumId: ALBUM_WRITABLE });
    const from = library.state.requests.length;
    const output = await run(state, id, hydrate(plan.parameters), { trigger: {} });
    assert.deepEqual(connectCalls(from).map(({ method, path }) => [method, path]), plan.requests);
    const first = Array.isArray(output) ? output[0] : output;
    if (plan.count !== undefined) assert.equal(output.length, plan.count);
    assert.partialDeepStrictEqual(first, plan.output);
    if (plan.binary) assert.deepEqual(first[plan.binary], JPEG);
  });
}

test('connection uses PKCE S256 with an RFC 7636 verifier, the exact Make callback and requested scopes', async () => {
  const state = await linked(['events:read']);
  const url = state.authorizeUrl;
  assert.equal(url.origin + url.pathname, `${ORIGIN}/api/oauth/apps/authorize`);
  assert.equal(url.searchParams.get('scope'), 'library:read events:read');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://www.make.com/oauth/cb/app');
  assert.match(url.searchParams.get('code_challenge'), /^[\w-]{43}$/);
  assert.equal(state.metadata.value, 'Frameleaf');
  await assert.rejects(
    connect(app, { serverUrl: 'https://library.test/api', frameleafClientId: CLIENT_ID }, library),
    ValidationError,
  );
});

test('universal module refuses traversal, absolute URLs, query strings and encoded paths before sending', async () => {
  const state = await linked(['library:read']);
  const from = library.state.requests.length;
  for (const url of ['../oauth/apps/grants', '/../oauth/apps/grants', '/albums/..', '/%2e%2e/oauth', '/albums?x=1',
    'https://evil.test/api', '//evil.test/x', '/albums\\..\\x', '/a b', 'albums', '/albums/', '/albums\n']) {
    await assert.rejects(run(state, 'makeApiCall', { url, method: 'GET' }), ValidationError, url);
  }
  await assert.rejects(run(state, 'makeApiCall', { url: '/albums', method: 'PUT' }), ValidationError);
  await assert.rejects(run(state, 'makeApiCall', { url: '/albums', method: 'GET', qs: [{ key: 'a&b', value: '1' }] }), ValidationError);
  await assert.rejects(run(state, 'getAsset', { assetId: '../../oauth/apps/grants' }), ValidationError);
  await assert.rejects(run(state, 'addTags', { assetId: ASSET, tags: ['a/b'] }), ValidationError);
  await assert.rejects(run(state, 'uploadPhoto', { sourceId: 'x', albumId: ALBUM_WRITABLE, fileName: '../a.jpg', data: JPEG, takenAt: '2026-01-01T00:00:00Z' }), ValidationError);
  assert.equal(library.state.requests.length, from, 'nothing reached the Library');
});

test('search pagination stops at the total and at the module limit', async () => {
  const state = await linked(['library:read']);
  let from = library.state.requests.length;
  assert.equal((await run(state, 'searchAssets', { limit: 3200 })).length, 230);
  assert.deepEqual(connectCalls(from).map(({ query }) => query.page), ['1', '2', '3']);
  from = library.state.requests.length;
  assert.equal((await run(state, 'searchAssets', { limit: 100 })).length, 100);
  assert.equal(connectCalls(from).length, 1);
});

test('watch events follows the cursor across pages and its stored position survives between runs', async () => {
  const state = await linked(['events:read']);
  library.state.events.length = 0;
  for (let n = 0; n < 250; n++) library.pushEvent('asset.ready', ASSET);
  const trigger = {};
  let from = library.state.requests.length;
  const first = await run(state, 'watchEvents', { limit: 1000 }, { trigger });
  assert.equal(first.length, 250);
  assert.deepEqual(connectCalls(from).map(({ query }) => query.cursor), [undefined, 'c100', 'c200']);
  assert.equal(new Set(first.map((event) => event.deliveryId)).size, 250);
  assert.deepEqual(await run(state, 'watchEvents', { limit: 1000 }, { trigger }), []);
  library.pushEvent('asset.ready', ASSET);
  const next = await run(state, 'watchEvents', { limit: 1000 }, { trigger });
  assert.equal(next.length, 1);
  assert.equal(next[0].deliveryId, library.state.events[0].deliveryId);
  from = library.state.requests.length;
  library.state.fail.push({ method: 'GET', path: '/events/latest', status: 410 });
  await assert.rejects(run(state, 'watchEvents', { limit: 10 }, { trigger }), { type: 'DataError' });
});

test('Library errors map to Make error types without echoing credentials', async () => {
  const state = await linked();
  const cases = [
    [401, 'InvalidAccessTokenError'], [403, 'InvalidConfigurationError'], [404, 'DataError'],
    [409, 'RateLimitError'], [429, 'RateLimitError'], [500, 'RuntimeError'],
  ];
  for (const [status, type] of cases) {
    library.state.fail.push({ method: 'GET', path: '/albums', status, message: 'boom' });
    const error = await run(state, 'listAlbums', { limit: 10 }).catch((caught) => caught);
    assert.ok(error instanceof MakeError);
    assert.equal(error.type, type, String(status));
    assert.ok(error.message.startsWith(`[${status}]`));
    assert.doesNotMatch(error.message, /fla_|flr_|Bearer/);
  }
  await assert.rejects(run(state, 'addAssetsToAlbum', { albumId: ALBUM_READ_ONLY, assetIds: [ASSET] }), { type: 'InvalidConfigurationError' });
  const narrow = await linked(['library:read']);
  await assert.rejects(run(narrow, 'createAlbum', { sourceId: 's', name: 'n' }), /Reconnect to allow albums:write/);
});

test('a 409 retry with the same Source ID and concurrent duplicate runs publish one photo', async () => {
  const state = await linked(['photos:upload']);
  const input = { sourceId: 'retry-1', albumId: ALBUM_WRITABLE, fileName: 'a.JPG', data: JPEG, takenAt: '2026-07-01T10:00:00.000Z' };
  library.state.fail.push({ method: 'POST', path: '/commit', status: 409 });
  await assert.rejects(run(state, 'uploadPhoto', input), { type: 'RateLimitError' });
  const retried = await run(state, 'uploadPhoto', input);
  assert.equal(retried.status, 'created');
  assert.equal((await run(state, 'uploadPhoto', input)).assetId, retried.assetId);

  const twin = { ...input, sourceId: 'twin-1' };
  const settled = await Promise.allSettled([run(state, 'uploadPhoto', twin), run(state, 'uploadPhoto', twin)]);
  const receipts = await Promise.all(
    settled.map((result) => (result.status === 'fulfilled' ? result.value : run(state, 'uploadPhoto', twin))),
  );
  for (const result of settled) if (result.status === 'rejected') assert.equal(result.reason.type, 'RateLimitError');
  assert.equal(receipts[0].assetId, receipts[1].assetId);
  const uploads = [...library.state.uploads.values()].filter((upload) => upload.requestId === 'twin-1');
  assert.equal(uploads.length, 1);
});

test('refresh rotates and stores both tokens; replaying a spent refresh token revokes the grant', async () => {
  const state = await linked(['library:read']);
  const original = { ...state.data };
  const later = new Date(Date.now() + 3600_000);
  await run(state, 'listAlbums', { limit: 10 }, { now: later });
  assert.notEqual(state.data.accessToken, original.accessToken);
  assert.notEqual(state.data.refreshToken, original.refreshToken);
  assert.ok(state.data.expires > Date.now());
  assert.equal(library.state.refresh.get(original.refreshToken).spent, true);

  // A second worker still holding the pre-rotation token. Make must serialize refresh per connection.
  const stale = { ...state, data: { ...original } };
  await assert.rejects(run(stale, 'listAlbums', { limit: 10 }, { now: later }), { type: 'ConnectionError' });
  await assert.rejects(run(state, 'listAlbums', { limit: 10 }), { type: 'InvalidAccessTokenError' });
});

test('deleting the Make connection revokes the grant', async () => {
  const state = await linked(['library:read']);
  await disconnect(app, state, { fetch: library.fetch });
  await assert.rejects(run(state, 'listAlbums', { limit: 10 }), { type: 'InvalidAccessTokenError' });
});

test('album pickers list writable albums only where a module writes', async () => {
  const state = await linked(['library:read']);
  const all = await runRpc(app, 'albums', {}, state, { fetch: library.fetch });
  const writable = await runRpc(app, 'albums', { writable: true }, state, { fetch: library.fetch });
  assert.ok(all.length >= 2);
  assert.ok(writable.every(({ value }) => library.state.albums.find((album) => album.id === value).canWrite));
  assert.ok(!writable.some(({ value }) => value === ALBUM_READ_ONLY));
  for (const id of ['addAssetsToAlbum', 'uploadPhoto'])
    assert.deepEqual(app.modules[id].parameters.find((spec) => spec.name === 'albumId').options, { store: 'rpc://albums?writable=true', nested: [] });
});
