import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const source = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const bare = (text) => stripTypeScriptTypes(text.replace(/^import .*;\n/gm, '').replace(/^export /gm, ''));

test('both live-photo fixtures bind requests, event waits, queues and completion to their test owner', async () => {
  const text = source('./specs/server/api/asset.e2e-spec.ts');
  const start = text.indexOf("    it('should clean up live photos'");
  const end = text.indexOf("\n  });\n\n  describe('GET /assets/:id/thumbnail'", start);
  assert.ok(start >= 0 && end > start);
  const callbacks = [];
  let owner;
  let creates = 0;
  let waits = 0;
  let settled = 0;
  const check = (signal) => {
    assert.equal(signal, owner.signal);
    signal.throwIfAborted();
  };
  const utils = {
    createAsset: async (_token, dto, options) => {
      check(options.signal);
      return { id: dto.livePhotoVideoId ? `photo-${++creates}` : 'motion' };
    },
    waitForWebsocketEvent: async ({ signal }) => {
      check(signal);
      waits++;
    },
    waitForAllQueuesFinish: async (_token, signal) => check(signal),
    waitForQueueFinish: async (_token, _queue, _timeout, signal) => check(signal),
    getAssetInfo: async (_token, id) => ({ id, livePhotoVideoId: 'motion' }),
    settlePendingWaits: async (signal) => {
      assert.equal(signal, owner.signal);
      settled++;
    },
  };
  const expect = (value) => ({
    toBe: (expected) => assert.equal(value, expected),
    resolves: {
      toMatchObject: async (expected) => {
        const result = await value;
        for (const [key, item] of Object.entries(expected)) assert.equal(result[key], item);
      },
    },
  });
  new Function(
    'it',
    'utils',
    'admin',
    'request',
    'app',
    'expect',
    'makeRandomImage',
    'LIVE_PHOTO_TIMEOUT',
    bare(text.slice(start, end)),
  )(
    (_name, _options, callback) => callbacks.push(callback),
    utils,
    { accessToken: 'token' },
    () => ({ delete: () => ({ send: () => ({ set: async () => ({ status: 204 }) }) }) }),
    'fixture',
    expect,
    () => new Uint8Array(),
    10_000,
  );
  assert.equal(callbacks.length, 2);
  for (const callback of callbacks) {
    for (const aborted of [false, true]) {
      owner = new AbortController();
      if (aborted) owner.abort(new Error('fixture owner expired'));
      let finish;
      const pending = callback({
        signal: owner.signal,
        onTestFinished: (cleanup) => {
          finish = cleanup;
        },
      });
      if (aborted) await assert.rejects(pending, /fixture owner expired/);
      else await pending;
      assert.equal(typeof finish, 'function');
      await finish();
    }
  }
  assert.equal(waits, 8);
  assert.equal(settled, 4);
});

test('shared-link hook joins asset readiness and aborts and settles its owned signal', async () => {
  const text = source('./specs/server/api/shared-link.e2e-spec.ts');
  const start = text.indexOf('    beforeAll(\n      withApiAssetReadiness');
  const end = text.indexOf("\n\n    describe('allowDownload=false'", start);
  assert.ok(start >= 0 && end > start);
  let hook;
  let ownerSignal;
  let ready = false;
  let settled = false;
  let assets = 0;
  const utils = {
    createAsset: async (_token, _dto, { signal }) => {
      ownerSignal ??= signal;
      assert.equal(signal, ownerSignal);
      return { id: `asset-${++assets}` };
    },
    waitForAssetReady: async (_token, id, { signal }) => {
      assert.equal(signal, ownerSignal);
      assert.equal(id, 'asset-1');
      ready = true;
    },
    createSharedLink: async () => {
      assert.equal(ready, true);
      return {};
    },
    settlePendingWaits: async (signal) => {
      assert.equal(signal, ownerSignal);
      assert.equal(signal.aborted, true);
      settled = true;
    },
  };
  const withApiAssetReadiness = new Function(
    'utils',
    bare(source('./api-asset-readiness.ts')) + '\nreturn withApiAssetReadiness;',
  )(utils);
  new Function(
    'beforeAll',
    'withApiAssetReadiness',
    'utils',
    'createAlbum',
    'asBearerAuth',
    'SharedLinkType',
    'admin',
    'user1',
    'let owned, outside, shared, other, noDownload, noUpload, withUpload;\n' + bare(text.slice(start, end)),
  )(
    (callback) => {
      hook = callback;
    },
    withApiAssetReadiness,
    utils,
    async () => ({ id: 'album' }),
    () => ({}),
    { Album: 'album' },
    { accessToken: 'admin' },
    { accessToken: 'user' },
  );
  await hook();
  assert.equal(assets, 2);
  assert.equal(ready, true);
  assert.equal(settled, true);
});
