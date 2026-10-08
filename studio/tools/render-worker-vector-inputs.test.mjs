import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { deriveClaimVectors } from './render-worker-vector-inputs.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const parentId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const source = Buffer.from(JSON.stringify({ v: '5', w: 64, h: 32, fr: 24, ip: 0, op: 48, layers: [], assets: [{ p: 'foreign.png', u: 'https://uncontrolled/' }] }));
const specimen = () => {
  const binding = { parent: { kind: 'vector-graphic', id: parentId, checksum: sha(source) }, location: { format: 'lottie-json', entry: null, pointer: '/assets/0/p', role: 'image' }, child: { kind: 'project-import', id: childId, checksum: sha(png) } };
  const resources = [ { key: `vector-graphic:${parentId}`, kind: 'vector-graphic', id: parentId, checksum: sha(source) }, { key: `project-import:${childId}`, kind: 'project-import', id: childId, checksum: sha(png) } ];
  return { operationId: 'op', claimToken: 'claim', revisionId: 'revision', artifactInputDigest: 'a'.repeat(64),
    snapshot: { studio: { graph: { metadata: { fps: 24 }, timeline: { items: [{ type: 'lottie', mediaId: parentId }], compositions: [{ id: 'unused', items: [{ type: 'lottie', mediaId: parentId }] }] }, studioVectorDependencies: { version: 1, bindings: [binding] } }, resources } },
    inputs: new Map(resources.map((resource, i) => [resource.key, { kind: resource.kind, resourceId: resource.id, declaredChecksum: resource.checksum, sha256: resource.checksum, bytes: Buffer.from(i ? png : source) }])) };
};
test('private execution embeds verified bytes while preserving original graph and authored locator', async () => {
  const prepared = specimen();
  const before = JSON.stringify(prepared.snapshot);
  const result = await deriveClaimVectors(prepared, () => true);
  assert.equal(JSON.stringify(prepared.snapshot), before);
  assert.equal(result.sources.length, 1);
  const animation = JSON.parse(result.sources[0].bytes);
  assert.equal(animation.assets[0].p, `data:image/png;base64,${png.toString('base64')}`);
  assert.equal(animation.assets[0].u, '');
  assert.equal(result.sources[0].metadata.fps, 24);
  assert.equal(result.sources[0].metadata.duration, 2);
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.resources.sort(), [...prepared.inputs.keys()].sort());
  result.sources.forEach(item => item.bytes.fill(0));
});
test('claim/revision/input digest independently bind the private materialization', async () => {
  const first = await deriveClaimVectors(specimen(), () => true);
  const second = specimen(); second.claimToken = 'reclaimed';
  const rebuilt = await deriveClaimVectors(second, () => true);
  assert.notEqual(first.digest, rebuilt.digest);
  for (const source of [...first.sources, ...rebuilt.sources]) source.bytes.fill(0);
});
test('changed parent or child bytes and missing/surplus declarations refuse', async () => {
  for (const key of [`vector-graphic:${parentId}`, `project-import:${childId}`]) {
    const prepared = specimen(); prepared.inputs.get(key).bytes[0] ^= 1;
    await assert.rejects(deriveClaimVectors(prepared, () => true));
  }
  const missing = specimen(); missing.snapshot.studio.graph.studioVectorDependencies.bindings = [];
  await assert.rejects(deriveClaimVectors(missing, () => true));
  const surplus = specimen(); surplus.snapshot.studio.graph.studioVectorDependencies.bindings.push({ ...surplus.snapshot.studio.graph.studioVectorDependencies.bindings[0], location: { format: 'lottie-json', entry: null, pointer: '/assets/1/p', role: 'image' } });
  await assert.rejects(deriveClaimVectors(surplus, () => true));
});
test('lease loss refuses before any private render input can be used', async () => {
  await assert.rejects(deriveClaimVectors(specimen(), () => false), /LEASE_LOST/);
  let count = 0;
  await assert.rejects(deriveClaimVectors(specimen(), () => ++count < 3), /LEASE_LOST/);
});
