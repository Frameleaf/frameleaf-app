import { randomUUID } from 'node:crypto';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { executeLibraryImportAction } from 'src/library-import/lifecycle.js';
import { manifestFingerprint, sourceKinds } from 'src/library-import/manifest.js';
import { EMPTY_SOURCE_ARCHIVE_HASH } from 'src/library-import/source-archive-codec.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

const setup = (kind = 'photoprism' as (typeof sourceKinds)[number]) => {
  const source = { ...fixture.plan.source, kind };
  const plan = parseDestinationImportPlan({ ...fixture.plan, source, owners: [], roots: [], files: [] });
  const manifest = {
    format: 'frameleaf-library-import' as const,
    version: 3 as const,
    source,
    inventory: {
      complete: true as const,
      ownershipComplete: true as const,
      privacyComplete: true as const,
      writersStopped: true as const,
      revisionBefore: source.revision,
      revisionAfter: source.revision,
    },
    users: [],
    files: [],
    assets: [],
    albums: [],
    losses: [],
  };
  const binding = {
    operationId: randomUUID(),
    source,
    manifestSha256: manifestFingerprint(manifest),
    planSha256: destinationPlanFingerprint(plan),
  };
  const bind = vi.fn();
  const authorize = vi.fn().mockRejectedValue(new LibraryImportRefused('SOURCE_OR_STORAGE_NOT_QUALIFIED'));
  return {
    input: {
      db: { query: vi.fn().mockResolvedValue([]), transaction: vi.fn() },
      jobs: {} as never,
      state: { inspect: () => null, bind } as never,
      destinationNonce: randomUUID(),
      bundle: {
        context: { binding, destinationId: plan.destinationId, manifest, plan },
        owners: [],
        descriptor: {
          format: 'frameleaf-source-archive' as const,
          version: 1 as const,
          rows: '0',
          sha256: EMPTY_SOURCE_ARCHIVE_HASH,
        },
        records: () => [],
        assertUnchanged: vi.fn().mockResolvedValue(undefined),
      },
      authorize,
    },
    bind,
    authorize,
  };
};

it.each(sourceKinds)('requires qualified source/storage authority before any %s import effects', async (kind) => {
  const { input, bind, authorize } = setup(kind);
  await expect(executeLibraryImportAction({ ...input, action: 'run' })).rejects.toThrow(
    'SOURCE_OR_STORAGE_NOT_QUALIFIED',
  );
  expect(authorize).toHaveBeenCalledOnce();
  expect(bind).not.toHaveBeenCalled();
  expect(input.db.transaction).not.toHaveBeenCalled();
});

it.each(['run', 'resume', 'rollback', 'abandon'] as const)(
  'refuses %s after the local writer boundary even if the destination journal is lost',
  async (action) => {
    const { input, bind, authorize } = setup();
    input.state = { inspect: () => ({ phase: 'activating', writersMayHaveStarted: true }), bind } as never;
    await expect(executeLibraryImportAction({ ...input, action })).rejects.toThrow(
      'IMPORT_POST_ACTIVATION_RECOVERY_REQUIRED',
    );
    expect(authorize).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  },
);
