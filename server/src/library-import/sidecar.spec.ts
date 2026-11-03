import { randomUUID } from 'node:crypto';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';

const setup = (roles: ('original' | 'sidecar' | 'companion')[] = ['original', 'sidecar']) => {
  const template = fixture.plan.files[0];
  const plan = parseDestinationImportPlan({
    ...fixture.plan,
    owners: [fixture.plan.owners[0]],
    files: roles.map((_, index) => ({
      ...template,
      id: `placement-${index}`,
      sourceAssetId: 'photo',
      sourceFileId: `file-${index}`,
      sourcePath: `source-${index}`,
      destinationPath: `target-${index}`,
      sourceIdentity: { ...template.sourceIdentity, inode: String(index + 1) },
    })),
  });
  const owner = plan.owners[0];
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 3,
    source: plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: plan.source.revision,
      revisionAfter: plan.source.revision,
    },
    users: [{ id: owner.sourceId, name: 'Synthetic owner' }],
    files: roles.map((role, index) => ({
      id: `file-${index}`,
      path: `source-${index}`,
      role,
      bytes: template.bytes,
      sha256: template.sha256,
    })),
    assets: [
      {
        id: 'photo',
        ownerId: owner.sourceId,
        fileIds: roles.map((_, index) => `file-${index}`),
        primaryFileId: 'file-0',
        type: 'IMAGE',
        fileModifiedAt: '2020-01-01T00:00:00Z',
        originalFileNames: { 'file-0': 'camera.jpg' },
        visibility: 'timeline',
        metadata: { takenAt: '2020-01-01T00:00:00Z', timeZone: 'UTC', description: 'Manual caption' },
      },
    ],
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    source: plan.source,
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
  };
  const writer = new CanonicalAssetWriter(
    { query: vi.fn(), transaction: vi.fn() },
    { binding, manifest, plan, destinationId: plan.destinationId },
  );
  const item = {
    sourceAssetId: 'photo',
    type: 'IMAGE',
    fileModifiedAt: '2020-01-01T00:00:00Z',
    originalFileNames: { 'file-0': 'camera.jpg' },
  };
  return { writer, item, bytes: BigInt(template.bytes) };
};

it('retains one metadata sidecar independently of media originals and original quota', () => {
  const { writer, item, bytes } = setup();
  const prepared = writer.prepare(item);
  expect(prepared.files.map((file) => file.role)).toEqual(['original', 'sidecar']);
  expect(prepared.primary.id).toBe('file-0');
  expect(prepared.bytes).toBe(bytes);
  expect(prepared.metadata.description).toBe('Manual caption');
});

it.each([
  ['original', 'sidecar', 'sidecar'],
  ['original', 'companion'],
] as const)('refuses unsupported extra file roles without dropping them: %s', (...roles) => {
  const { writer, item } = setup([...roles]);
  expect(() => writer.prepare(item)).toThrow('ASSET_UNSUPPORTED_FIELDS');
});
