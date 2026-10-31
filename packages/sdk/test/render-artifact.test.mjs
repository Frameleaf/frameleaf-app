import assert from 'node:assert/strict';
import test from 'node:test';
import { readRenderArtifact, uploadRenderArtifact } from '../build/index.js';

const identity = {
  id: 'operation',
  sequence: 0,
  chunkKey: 'whole',
  xFrameleafWorkerSession: 'private-session',
  xRenderClaimToken: 'private-claim',
};
const bytes = new Uint8Array([0, 255, 128, 10]);

test('artifact upload preserves binary bytes and keeps both credentials in headers', async () => {
  const body = new Blob([bytes], { type: 'application/octet-stream' });
  const result = await uploadRenderArtifact(
    { ...identity, body, checksum: 'a'.repeat(64), sizeInBytes: '4' },
    {
      fetch: async (url, options) => {
        assert.equal(options.method, 'PUT');
        assert.equal(url.includes('private-session'), false);
        assert.equal(url.includes('private-claim'), false);
        assert.equal(new URL(url, 'http://local').searchParams.get('chunkKey'), 'whole');
        const headers = new Headers(options.headers);
        assert.equal(headers.get('x-frameleaf-worker-session'), identity.xFrameleafWorkerSession);
        assert.equal(headers.get('x-render-claim-token'), identity.xRenderClaimToken);
        assert.deepEqual(new Uint8Array(await options.body.arrayBuffer()), bytes);
        return new Response(JSON.stringify({ accepted: true, refusal: null }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    },
  );
  assert.equal(result.accepted, true);
});

test('artifact read preserves raw bytes without URL credentials or JSON conversion', async () => {
  const result = await readRenderArtifact(identity, {
    fetch: async (url, options) => {
      assert.equal(url, '/api/render-workers/operations/operation/artifacts/0?chunkKey=whole');
      const headers = new Headers(options.headers);
      assert.equal(headers.get('x-frameleaf-worker-session'), identity.xFrameleafWorkerSession);
      assert.equal(headers.get('x-render-claim-token'), identity.xRenderClaimToken);
      return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    },
  });
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
});
