import { randomUUID } from 'node:crypto';
import { LibraryImportController } from 'src/library-import/controller.js';
import { libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import fixture from 'src/library-import/fixtures/manager-plan-v1.json' with { type: 'json' };
import { executeLibraryImportAction } from 'src/library-import/lifecycle.js';
import { manifestFingerprint, sourceKinds } from 'src/library-import/manifest.js';
import { EMPTY_SOURCE_ARCHIVE_HASH } from 'src/library-import/source-archive-codec.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

afterEach(() => vi.restoreAllMocks());

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

it.each(['dispatch', 'writers'] as const)(
  'rechecks live authority before fresh activation %s effects',
  async (boundary) => {
    const { input, bind, authorize } = setup();
    const { binding } = input.bundle.context;
    const journal = {
      begin: vi.fn(),
      review: () => ({ plan: { files: [] } }),
      recordVerification: vi.fn(),
      writersStarting: vi.fn(),
    };
    const mark = vi.fn();
    bind.mockReturnValue(journal);
    input.state = { inspect: () => ({ phase: 'verifying', writersMayHaveStarted: false }), bind, mark } as never;
    vi.spyOn(LibraryImportController.prototype, 'status').mockResolvedValue({
      run: { operationId: binding.operationId, source: binding.source, status: 'verifying' },
      mappings: [],
    });
    const digest = { sha256: 'a'.repeat(64) };
    vi.spyOn(LibraryImportController.prototype, 'verify').mockResolvedValue({
      owners: digest,
      assets: digest,
      albums: digest,
      stacks: digest,
      archive: digest,
    } as never);
    const dispatch = vi.fn().mockResolvedValue(libraryImportDerivedRunId(binding));
    input.jobs = { dispatchImportedLibraryWork: dispatch } as never;
    authorize.mockReset().mockResolvedValueOnce(undefined);
    if (boundary === 'writers') authorize.mockResolvedValueOnce(undefined);
    authorize.mockRejectedValue(new LibraryImportRefused('SOURCE_REFUSED'));
    await expect(executeLibraryImportAction({ ...input, action: 'verify', activate: true })).rejects.toThrow(
      'SOURCE_REFUSED',
    );
    expect(dispatch).toHaveBeenCalledTimes(boundary === 'dispatch' ? 0 : 1);
    expect(journal.writersStarting).not.toHaveBeenCalled();
    expect(mark).not.toHaveBeenCalled();
  },
);
