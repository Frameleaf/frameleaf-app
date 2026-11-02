import { randomUUID } from 'node:crypto';
import { ImportDatabase } from 'src/immich-import/types.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { BundleVerificationError, verifyImportFiles } from 'src/library-import/files.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';

vi.mock('src/library-import/files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/library-import/files.js')>()),
  verifyImportFiles: vi.fn(),
}));

const setup = () => {
  const plan = parseDestinationImportPlan(fixture.plan),
    file = plan.files[0],
    owner = plan.owners[0];
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
    users: [{ id: owner.sourceId, name: 'Synthetic owner' }],
    files: [{ id: file.id, path: file.sourcePath, bytes: file.bytes, sha256: file.sha256, role: 'original' }],
    assets: [
      {
        id: 'photo',
        ownerId: owner.sourceId,
        fileIds: [file.id],
        primaryFileId: file.id,
        visibility: 'timeline',
        metadata: { takenAt: '2020-01-02T03:04:05Z', timeZone: 'UTC' },
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
