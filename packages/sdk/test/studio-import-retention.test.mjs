import assert from 'node:assert/strict';
import test from 'node:test';
import * as sdk from '../build/index.js';
const projectId = '0198a1c2-0000-7000-8000-0000000000aa';
const importId = '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01';
const publicationId = '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e02';
const response = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const lineage = {
  version: 1,
  family: 'anime4k',
  evidence: 'client-reported',
  variant: 'animation',
  source: { namespace: 'freecut-media', id: importId, projectId },
  input: { width: 640, height: 360 },
  output: { width: 1280, height: 720, fps: 30, frameCount: 30, codec: 'avc1' },
};
const receipt = {
  publicationId,
  importId,
  state: 'registered',
  createdAt: '2026-10-11T00:00:00Z',
  expiresAt: '2026-10-11T06:00:00Z',
  cleanupPending: false,
};
test('canonical generated SDK exports and transports all publication operations', async () => {
  const cases = [
    [
      'registerStudioImportPublication',
      { id: projectId, studioImportPublicationRegisterDto: { publicationId, importId } },
      'POST',
      `/api/studio/projects/${projectId}/imports/publications`,
      receipt,
    ],
    [
      'getStudioImportPublications',
      { id: projectId, cursor: 'Y3Vyc29y', state: 'published' },
      'GET',
      `/api/studio/projects/${projectId}/imports/publications?cursor=Y3Vyc29y&state=published`,
      { items: [receipt], nextCursor: null },
    ],
    [
      'getStudioImportPublication',
      { id: projectId, publicationId },
      'GET',
      `/api/studio/projects/${projectId}/imports/publications/${publicationId}`,
      receipt,
    ],
    [
      'cancelStudioImportPublication',
      { id: projectId, importId, publicationId },
      'POST',
      `/api/studio/projects/${projectId}/imports/${importId}/publications/${publicationId}/cancel`,
      { status: 'cancelled', receipt },
    ],
  ];
  for (const [name, params, method, expectedUrl, result] of cases) {
    assert.equal(typeof sdk[name], 'function', name);
    const actual = await sdk[name](params, {
      fetch: async (url, options) => {
        const parsed = new URL(url, 'https://fixture.invalid');
        const expected = new URL(expectedUrl, 'https://fixture.invalid');
        assert.equal(parsed.pathname, expected.pathname);
        assert.deepEqual([...parsed.searchParams].sort(), [...expected.searchParams].sort());
        assert.equal(options.method ?? 'GET', method);
        if (name === 'registerStudioImportPublication')
          assert.deepEqual(JSON.parse(options.body), { publicationId, importId });
        return response(result);
      },
    });
    assert.deepEqual(actual, result);
  }
});
test('multipart preserves lineage JSON exactly once, binary bytes and legacy omission', async () => {
  for (const withLineage of [false, true]) {
    const file = new File([new Uint8Array([0, 255, 128, 34])], 'out.mp4', { type: 'video/mp4' });
    const body = {
      id: importId,
      file,
      ...(withLineage ? { publicationId, processingProvenance: JSON.stringify(lineage) } : {}),
    };
    await sdk.importStudioProjectFile(
      { id: projectId, studioProjectImportCreateDto: body },
      {
        fetch: async (_url, options) => {
          assert.ok(options.body instanceof FormData);
          assert.deepEqual(
            new Uint8Array(await options.body.get('file').arrayBuffer()),
            new Uint8Array([0, 255, 128, 34]),
          );
          assert.equal(options.body.get('processingProvenance'), withLineage ? JSON.stringify(lineage) : null);
          assert.equal(options.body.get('publicationId'), withLineage ? publicationId : null);
          return response({});
        },
      },
    );
  }
});
