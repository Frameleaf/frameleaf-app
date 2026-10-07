import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createClaimImageInputs } from './render-worker-image-inputs.mjs';

// An input specimen, never an asserted render output. The test uses the prepared engine's real
// collectMediaIds and media server, including its Range handling; no renderer is mocked.
const sharp = createRequire(new URL('../engine/package.json', import.meta.url))('sharp');
const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer();
const mediaId = '11111111-1111-4111-8111-111111111111';
const prepared = () => ({
  operationId: randomUUID(), claimToken: randomUUID(), revisionId: 'immutable-revision-7',
  snapshot: { studio: { stored: true, revision: 7, graph: {
    id: 'project', name: 'Image specimen', description: '', createdAt: 0, updatedAt: 0, duration: 1,
    metadata: { width: 32, height: 32, fps: 24 },
    timeline: { tracks: [{ id: 'v1', name: 'V1', kind: 'video', height: 80, locked: false,
      visible: true, muted: false, solo: false, order: 0 }],
    items: [{ id: 'clip', type: 'image', mediaId, trackId: 'v1', from: 0, durationInFrames: 24 }],
    transitions: [], keyframes: [] },
  } } },
  inputs: new Map([[`library-asset:${mediaId}`, { resourceId: mediaId, kind: 'library-asset',
    bytes: Buffer.from(png), sha256: createHash('sha256').update(png).digest('hex') }]]),
});

test('real Freecut input contract preserves graph and serves only bound bytes while lease is live', async () => {
  const claim = prepared();
  const original = structuredClone(claim.snapshot.studio.graph);
  let live = true;
  const adapted = await createClaimImageInputs(claim, () => live);
  const url = adapted.input.media[0].url;
  try {
    assert.deepEqual(adapted.input.project, original);
    assert.notEqual(adapted.input.project, claim.snapshot.studio.graph);
    assert.deepEqual(adapted.binding, { operationId: claim.operationId, claimToken: claim.claimToken, revisionId: claim.revisionId });
    assert.equal(adapted.input.media[0].mediaId, mediaId);
    assert.equal(adapted.input.strict, true);
    assert.ok(!url.includes(mediaId) && !url.includes(claim.claimToken));
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const partial = await fetch(url, { headers: { Range: 'bytes=0-7' } });
    assert.equal(partial.status, 206);
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), png.subarray(0, 8));
    const unbound = new URL(`/media/${mediaId}`, url);
    const denied = await fetch(unbound);
    assert.equal(denied.status, 404);
    await denied.arrayBuffer();
    live = false;
    const revoked = await fetch(url);
    assert.equal(revoked.status, 404);
    await revoked.arrayBuffer();
    assert.deepEqual(claim.snapshot.studio.graph, original);
  } finally { await adapted.dispose(); }
  await assert.rejects(fetch(url));
  await adapted.dispose();
});

test('cannot rebind verified bytes or substitute another resource identity', async () => {
  const changed = prepared();
  changed.inputs.get(`library-asset:${mediaId}`).bytes[0] ^= 1;
  await assert.rejects(createClaimImageInputs(changed, () => true), /VERIFIED_INPUT_CHANGED/);
  const substituted = prepared();
  substituted.inputs.get(`library-asset:${mediaId}`).resourceId = 'another-asset';
  await assert.rejects(createClaimImageInputs(substituted, () => true), /AUTHORIZED_IMAGE_INPUT_REQUIRED/);
});

test('unsupported resource adapters and expired leases fail before opening source URLs', async () => {
  for (const type of ['video', 'audio', 'text', 'composition']) {
    const claim = prepared();
    claim.snapshot.studio.graph.timeline.items[0].type = type;
    await assert.rejects(createClaimImageInputs(claim, () => true), /IMAGE_SOURCE_ADAPTER_ONLY/);
  }
  const linked = prepared();
  linked.snapshot.studio.graph.timeline.items[0].src = 'https://unapproved.example/source';
  await assert.rejects(createClaimImageInputs(linked, () => true), /IMAGE_SOURCE_ADAPTER_ONLY/);
  await assert.rejects(createClaimImageInputs(prepared(), () => false), /LEASE_LOST/);
});

test('nested non-byte resources are rejected even when every byte grant is a valid image', async () => {
  for (const nested of [
    { modelId: 'upscale-model' },
    { $resource: { kind: 'model', id: 'upscale-model' } },
    { $resource: { kind: 'preset', id: 'alpine', family: 'look' } },
    { grade: { look: 'alpine' } },
    { transitionIn: { type: 'Cross dissolve' } },
  ]) {
    const claim = prepared();
    claim.snapshot.studio.graph.timeline.items[0].effects = [{ params: { nested } }];
    await assert.rejects(createClaimImageInputs(claim, () => true), /UNSUPPORTED_GRAPH_RESOURCE/);
  }
});

test('matching grant hashes do not admit text, video, malformed or incomplete image content', async () => {
  const truncated = png.subarray(0, png.length - 5);
  const corrupt = Buffer.from(png);
  corrupt[corrupt.indexOf(Buffer.from('IDAT')) + 4] ^= 0xff;
  for (const bytes of [Buffer.from('authorized specimen'), Buffer.from('....ftypisom'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), truncated, corrupt]) {
    const claim = prepared();
    const input = claim.inputs.get(`library-asset:${mediaId}`);
    input.bytes = bytes;
    input.sha256 = createHash('sha256').update(bytes).digest('hex');
    await assert.rejects(createClaimImageInputs(claim, () => true));
  }
});

test("intrinsic rectangle cuts preserve the immutable HDR graph without inventing media", async () => {
  const claim = prepared();
  claim.inputs.clear();
  claim.snapshot.studio.graph.metadata.colorManagement = {
    workingRange: "hdr",
    referenceWhiteNits: 203,
  };
  claim.snapshot.studio.graph.timeline.items = [0, 1].map((from) => ({
    id: `shape-${from}`,
    type: "shape",
    shapeType: "rectangle",
    trackId: "v1",
    from,
    durationInFrames: 1,
    fillColor: from ? "#336699" : "rgb(250%, 120%, 60%)",
    strokeEnabled: false,
    strokeWidth: 0,
    transform: { x: 0, y: 0, width: 32, height: 32, rotation: 0, opacity: 1 },
  }));
  const original = structuredClone(claim.snapshot.studio.graph);
  const adapted = await createClaimImageInputs(claim, () => true);
  try {
    assert.deepEqual(adapted.input.project, original);
    assert.deepEqual(adapted.input.media, []);
    assert.deepEqual(claim.snapshot.studio.graph, original);
  } finally {
    await adapted.dispose();
  }
});
