import { randomUUID } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { BundleVerificationError, verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import placements from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';

vi.mock('src/library-import/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/library-import/files.js')>()),
  verifyImportFiles: vi.fn(),
}));

const setup = (sealed = false, tags?: string[]) => {
  const plan = parseDestinationImportPlan(fixture.plan),
    file = plan.files[0],
    owner = plan.owners[0];
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: sealed ? 3 : 2,
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
    files: [{ id: file.id, path: file.sourcePath, bytes: file.bytes, sha256: file.sha256, role: 'original' }],
    assets: [
      {
        ...(sealed
          ? { type: 'IMAGE', fileModifiedAt: '2020-01-02T03:04:05Z', originalFileNames: { [file.id]: 'photo.jpg' } }
          : {}),
        id: 'photo',
        ownerId: owner.sourceId,
        fileIds: [file.id],
        primaryFileId: file.id,
        visibility: 'timeline',
        metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC', ...(tags === undefined ? {} : { tags }) },
      },
    ],
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
    source: plan.source,
  };
  const query = vi.fn((statement: string) => {
    if (statement.includes('pg_try_advisory_xact_lock')) return Promise.resolve([{ acquired: true }]);
    if (statement.includes('SELECT binding,status')) return Promise.resolve([{ binding, status: 'copying' }]);
    if (statement.includes('SELECT u.id')) return Promise.resolve([{ id: owner.destinationId }]);
    if (statement.includes('pg_timezone_names')) return Promise.resolve([{}]);
    return Promise.resolve([]);
  });
  const db: ImportDatabase = { query, transaction: (body) => body(db) };
  const writer = new CanonicalAssetWriter(db, { binding, plan, manifest, destinationId: plan.destinationId });
  const item = {
    sourceAssetId: 'photo',
    type: 'IMAGE',
    fileModifiedAt: '2020-01-02T03:04:05Z',
    originalFileNames: { [file.id]: 'photo.jpg' },
  };
  return { writer, item, query };
};
beforeEach(() => {
  vi.mocked(verifyImportFiles).mockReset();
});

it('prepares independent placements without changing the source file identity', () => {
  const plan = parseDestinationImportPlan(placements.plan);
  const manifest = parseImportManifest({
    format: 'frameleaf-library-import',
    version: 2,
    source: plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: plan.source.revision,
      revisionAfter: plan.source.revision,
    },
    users: [
      { id: 'owner-1', name: 'Synthetic' },
      { id: 'owner-2', name: 'Other synthetic' },
    ],
    files: [{ id: 'file-1', path: 'camera.jpg', bytes: '14', sha256: plan.files[0].sha256, role: 'original' }],
    assets: ['asset-1', 'asset-2'].map((id) => ({
      id,
      ownerId: id === 'asset-1' ? 'owner-1' : 'owner-2',
      fileIds: ['file-1'],
      primaryFileId: 'file-1',
      visibility: 'timeline',
      metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC' },
    })),
    albums: [],
    losses: [],
  });
  const binding = {
    operationId: randomUUID(),
    source: plan.source,
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
  };
  const query = vi.fn();
  const db: ImportDatabase = { query, transaction: (body) => body(db) };
  const writer = new CanonicalAssetWriter(db, { binding, plan, manifest, destinationId: plan.destinationId });
  const prepared = ['asset-1', 'asset-2'].map((sourceAssetId) =>
    writer.prepare({
      sourceAssetId,
      type: 'IMAGE',
      fileModifiedAt: '2020-01-02T03:04:05Z',
      originalFileNames: { 'file-1': sourceAssetId + '.jpg' },
    }),
  );
  expect(prepared.map((photo) => photo.files[0].path)).toEqual(['owner/camera.jpg', 'second/camera.jpg']);
  expect(prepared.map((photo) => photo.files[0].id)).toEqual(['file-1', 'file-1']);
  expect(query).not.toHaveBeenCalled();
});

it.each(['BUNDLE_FILE_MISMATCH', 'BUNDLE_ROOT_CHANGED', 'BUNDLE_FILE_UNAVAILABLE'])(
  'retains the stable verification refusal before any database writes: %s',
  async (code) => {
    const { writer, item, query } = setup();
    vi.mocked(verifyImportFiles).mockRejectedValue(new BundleVerificationError(code));
    await expect(writer.write(item)).rejects.toMatchObject({ code, message: `Library import refused: ${code}` });
    expect(query.mock.calls.some(([statement]) => /^\s*(INSERT|UPDATE|DELETE)\b/.test(statement))).toBe(false);
  },
);

it('redacts unexpected filesystem diagnostics instead of exposing private paths', async () => {
  const { writer, item } = setup();
  vi.mocked(verifyImportFiles).mockRejectedValue(
    Object.assign(new Error('private host path /synthetic/private/original.jpg'), { code: 'BUNDLE_FILE_MISMATCH' }),
  );
  await expect(writer.write(item)).rejects.toMatchObject({
    code: 'ASSET_WRITE_FAILED',
    message: 'Library import refused: ASSET_WRITE_FAILED',
  });
});

it('keeps the bound writer intent isolated from mutations of a prepared result', async () => {
  const { writer, item } = setup();
  const original = writer.prepare(item);
  const changed = writer.prepare(item);
  changed.metadata.description = 'changed';
  changed.files[0].root.path = '/changed';
  changed.files[0].root.device = '999';
  changed.files[0].root.inode = '999';
  expect(writer.prepare(item)).toEqual(original);
  vi.mocked(verifyImportFiles).mockRejectedValue(new BundleVerificationError('BUNDLE_FILE_MISMATCH'));
  await expect(writer.write(item)).rejects.toThrow('BUNDLE_FILE_MISMATCH');
  expect(verifyImportFiles).toHaveBeenCalledWith(original.files[0].root.path, expect.any(Array), {
    device: original.files[0].root.device,
    inode: original.files[0].root.inode,
  });
});

it.each(['type', 'clock', 'name'])('refuses changed sealed %s before touching the destination', (field) => {
  const { writer, item, query } = setup(true);
  switch (field) {
    case 'type': {
      item.type = 'VIDEO';
      break;
    }
    case 'clock': {
      item.fileModifiedAt = '2021-01-02T03:04:05Z';
      break;
    }
    case 'name': {
      item.originalFileNames[Object.keys(item.originalFileNames)[0]] = 'changed.jpg';
      break;
    }
    // No default
  }
  expect(() => writer.prepare(item)).toThrow('ASSET_PREPARED_INTENT_CHANGED');
  expect(query).not.toHaveBeenCalled();
});

it.each([[''], ['/name'], ['name/'], ['name//child'], ['name\0'], ['same', 'same']])(
  'refuses noncanonical tag intent before querying the destination: %j',
  (...tags) => {
    const { writer, item, query } = setup(false, tags);
    expect(() => writer.prepare(item)).toThrow('ASSET_TAGS_INVALID');
    expect(query).not.toHaveBeenCalled();
  },
);
it('keeps source tag intent isolated from changes to prepared metadata', () => {
  const { writer, item } = setup(false, ['Places/Canada']);
  const prepared = writer.prepare(item);
  prepared.metadata.tags!.push('changed');
  expect(writer.prepare(item).metadata.tags).toEqual(['Places/Canada']);
});
