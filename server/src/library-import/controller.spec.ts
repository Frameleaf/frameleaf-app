import { randomUUID } from 'node:crypto';
import { type ImportDatabase } from 'src/immich-import/types.js';
import { LibraryImportController } from 'src/library-import/controller.js';
import { libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

const context = (change: Record<string, unknown> = {}) => {
  const plan = parseDestinationImportPlan(fixture.plan);
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
    users: [{ id: 'owner-1', name: 'Source owner' }],
    files: [{ id: 'file-1', path: 'camera.jpg', bytes: '14', sha256: plan.files[0].sha256, role: 'original' }],
    assets: [
      {
        id: 'photo-1',
        ownerId: 'owner-1',
        fileIds: ['file-1'],
        primaryFileId: 'file-1',
        type: 'IMAGE',
        fileModifiedAt: '2020-01-01T00:00:00Z',
        originalFileNames: { 'file-1': 'camera.jpg' },
        visibility: 'timeline',
        metadata: { takenAt: '2020-01-01T00:00:00Z', timeZone: 'UTC' },
      },
    ],
    albums: [],
    losses: [],
    ...change,
  });
  return {
    manifest,
    plan,
    destinationId: plan.destinationId,
    binding: {
      operationId: randomUUID(),
      source: plan.source,
      manifestSha256: manifestFingerprint(manifest),
      planSha256: destinationPlanFingerprint(plan),
    },
  };
};
const db = { query: vi.fn(), transaction: vi.fn() };
const owners = [
  {
    intent: {
      sourceUserId: 'owner-1',
      email: 'owner@example.test',
      login: {
        revision: 'frozen-1',
        snapshotSha256: 'e'.repeat(64),
        accountEnabled: true,
        passwordLoginEnabled: true,
        secondFactorRequired: false,
        externalIdentityRequired: false,
        ownedLibraryAccess: 'full',
        otherRestrictions: 'none',
      },
      disposition: { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true },
    },
  },
];
beforeEach(() => vi.clearAllMocks());

it('requires complete sealed intents before preparing a destination', () => {
  const input = context({ version: 1, assets: [], files: [] });
  input.plan.files = [];
  input.binding.planSha256 = destinationPlanFingerprint(input.plan);
  expect(() => new LibraryImportController(db, input)).toThrow('IMPORT_REQUIRES_SEALED_MANIFEST');
  expect(db.query).not.toHaveBeenCalled();
});
it('refuses unacknowledged source losses before database access', async () => {
  const input = context({ losses: [{ code: 'UNSUPPORTED_SOURCE_FEATURE', acknowledged: false }] });
  await expect(new LibraryImportController(db, input).preflight(owners)).rejects.toThrow(
    'IMPORT_LOSSES_NOT_ACKNOWLEDGED',
  );
  expect(db.query).not.toHaveBeenCalled();
});
it('checks every canonical asset intent before creating an import journal', async () => {
  const input = context();
  input.manifest.assets[0].metadata.title = 'Not representable yet';
  input.binding.manifestSha256 = manifestFingerprint(input.manifest);
  await expect(new LibraryImportController(db, input).preflight(owners)).rejects.toThrow('ASSET_UNSUPPORTED_FIELDS');
  expect(db.query).not.toHaveBeenCalled();
});
it('refuses incomplete owner mappings before database access', async () => {
  await expect(new LibraryImportController(db, context()).preflight([])).rejects.toThrow(
    'OWNER_RECONCILIATION_MISMATCH',
  );
  expect(db.query).not.toHaveBeenCalled();
});
it('refuses duplicate normalized owner emails before database access', async () => {
  const input = context();
  const second = structuredClone(owners[0]);
  second.intent.sourceUserId = 'owner-2';
  second.intent.email = 'OWNER@EXAMPLE.TEST';
  input.manifest.users.push({ id: 'owner-2', name: 'Second owner' });
  input.plan.owners.push({ sourceId: 'owner-2', destinationId: randomUUID() });
  input.binding.manifestSha256 = manifestFingerprint(input.manifest);
  input.binding.planSha256 = destinationPlanFingerprint(input.plan);
  await expect(new LibraryImportController(db, input).preflight([...owners, second])).rejects.toThrow(
    'OWNER_EMAIL_COLLISION',
  );
  expect(db.query).not.toHaveBeenCalled();
});

it('returns progress without the protected source binding', async () => {
  const input = context();
  const mappings = [{ kind: 'asset', count: '1' }];
  db.query.mockResolvedValueOnce([{ binding: input.binding, status: 'verifying' }]).mockResolvedValueOnce(mappings);
  expect(await new LibraryImportController(db, input).status()).toEqual({
    run: {
      operationId: input.binding.operationId,
      source: { kind: input.binding.source.kind, version: input.binding.source.version },
      status: 'verifying',
    },
    mappings,
  });
});
it('still refuses another binding before returning public progress', async () => {
  const input = context();
  db.query
    .mockResolvedValueOnce([{ binding: { ...input.binding, operationId: randomUUID() }, status: 'verifying' }])
    .mockResolvedValueOnce([]);
  await expect(new LibraryImportController(db, input).status()).rejects.toThrow('IMPORT_BINDING_CHANGED');
});
it('returns empty progress before the journal exists', async () => {
  db.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
  expect(await new LibraryImportController(db, context()).status()).toEqual({ run: null, mappings: [] });
});

it('checks the live source on an owned session before preparing fresh activation work', async () => {
  const input = context();
  const row = { binding: input.binding, status: 'verifying' };
  const session: ImportDatabase = {
    query: vi.fn().mockResolvedValue([{ ...row, acquired: true }]),
    transaction: vi.fn(),
  };
  const database: ImportDatabase = {
    query: vi.fn().mockResolvedValue([row]),
    transaction: vi.fn(),
    withSession: async (work) => work(session),
  };
  const dispatch = vi.fn().mockResolvedValue(libraryImportDerivedRunId(input.binding));
  const source = vi.fn().mockRejectedValue(new LibraryImportRefused('SOURCE_REFUSED'));
  await expect(
    new LibraryImportController(database, input).activate({ dispatchImportedLibraryWork: dispatch } as never, source),
  ).rejects.toThrow('SOURCE_REFUSED');
  expect(source).toHaveBeenCalledWith(session);
  expect(dispatch).not.toHaveBeenCalled();
  expect(session.transaction).not.toHaveBeenCalled();
});
