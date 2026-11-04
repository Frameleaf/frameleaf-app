import { type ImportDatabase } from 'src/immich-import/types.js';
import { loadLibraryImportBundle, loadRetainedLibraryImportBundle } from 'src/library-import/bundle-input.js';
import { summarizeReviewedImport } from 'src/library-import/bundle-output.js';
import { ensureImportBootstrapAdmin } from 'src/library-import/bootstrap-admin.js';
import { readPrivateImportJSON, type LibraryImportCommandConfig } from 'src/library-import/command-input.js';
import { LibraryImportController } from 'src/library-import/controller.js';
import { type ManagerLibrarySetup } from 'src/library-import/derived-work.js';
import { withLibraryImportExecution, withLibraryImportInspection } from 'src/library-import/execution-binding.js';
import { assertImportExecutionLock } from 'src/library-import/execution-lock.js';
import { executeLibraryImportAction } from 'src/library-import/lifecycle.js';
import { type LocalLibraryImportState } from 'src/library-import/local-transfer-state.js';
import { type SourceKind } from 'src/library-import/manifest.js';
import { LibrarySourceArchive } from 'src/library-import/source-archive.js';
import { LibraryImportJournal, LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';
import { importPlanSha256, reviewImportFiles } from 'src/library-import/transfer-runtime.js';
import { type JobRepository } from 'src/repositories/job.repository.js';

type Action = 'preflight' | 'run' | 'status' | 'resume' | 'verify' | 'rollback' | 'abandon';
type Context = Awaited<ReturnType<typeof loadLibraryImportBundle>>['context'];

/** Trusted application caller supplies live source/storage authority; a private bundle cannot qualify itself. */
export async function executeLibraryImportCommand(input: {
  action: Action;
  activate?: boolean;
  config: LibraryImportCommandConfig;
  source: SourceKind;
  db: ImportDatabase;
  jobs: JobRepository;
  state: LocalLibraryImportState;
  manager?: ManagerLibrarySetup;
  authorize: (action: Action, context: Pick<Context, 'binding' | 'destinationId'>) => Promise<void>;
}) {
  const { action, config, source, db, state } = input;
  if (input.activate && action !== 'verify') throw new LibraryImportRefused('IMPORT_ACTIVATION_REQUIRES_VERIFY');
  if (typeof input.authorize !== 'function') throw new LibraryImportRefused('IMPORT_SOURCE_AUTHORITY_REQUIRED');
  const lock = await assertImportExecutionLock(config.stateDirectory);
  if (JSON.stringify(lock) !== JSON.stringify(state.identity.lock))
    throw new LibraryImportRefused('IMPORT_EXECUTION_IDENTITY_CHANGED');
  const operation = state.db.prepare('SELECT id,value FROM operations LIMIT 1').get();
  if (operation && operation.id !== config.operationId) throw new LibraryImportRefused('IMPORT_BINDING_CHANGED');
  let localBinding;
  if (operation) {
    try {
      const value = JSON.parse(String(operation.value));
      localBinding = parseLibraryImportBinding(value.input.binding);
      if (
        value.input.destinationId !== config.destinationId ||
        localBinding.operationId !== config.operationId ||
        localBinding.source.kind !== source
      )
        throw new Error('Changed local binding');
    } catch {
      throw new LibraryImportRefused('IMPORT_BINDING_CHANGED');
    }
  }
  const status = await new LibraryImportJournal(db).status();
  if (
    status.run &&
    (status.run.binding.operationId !== config.operationId ||
      status.run.binding.source.kind !== source ||
      (localBinding && JSON.stringify(localBinding) !== JSON.stringify(status.run.binding)))
  )
    throw new LibraryImportRefused('IMPORT_BINDING_CHANGED');
  const local = state.inspect(config.operationId);
  const reportedRun = status.run
    ? {
        operationId: status.run.binding.operationId,
        source: { kind: status.run.binding.source.kind, version: status.run.binding.source.version },
        status: status.run.status,
      }
    : null;
  if (action === 'status') return { run: reportedRun, mappings: status.mappings, execution: local };
  const untouched =
    !!local &&
    !local.writersMayHaveStarted &&
    local.files.length === 0 &&
    status.mappings.length === 0 &&
    (local.phase === 'prepared' || local.phase === 'abandoned') &&
    (!status.run || ['copying', 'abandoned'].includes(status.run.status));
  // Preparation retains metadata before any media intent. Cancellation must also work if that export was lost.
  if (untouched && localBinding && (action === 'abandon' || action === 'rollback')) {
    await input.authorize(action, { binding: localBinding, destinationId: config.destinationId });
    if (local.abandoned) {
      if (status.run && status.run.status !== 'abandoned') throw new LibraryImportRefused('IMPORT_PHASE_CHANGED');
      return { run: reportedRun, mappings: status.mappings, execution: local };
    }
    const binding = localBinding;
    return withLibraryImportExecution(
      db,
      { binding, destinationId: config.destinationId, identity: state.identity },
      async (destinationNonce) => {
        const journal = state.bind(config.operationId, {
          binding,
          destinationId: config.destinationId,
          destinationNonce,
        });
        if (!state.db.prepare('SELECT 1 FROM library_import_runs WHERE operation_id=?').get(config.operationId))
          journal.begin(config.operationId, { manifestSha256: binding.manifestSha256, planSha256: binding.planSha256 });
        if (status.run) await new LibraryImportJournal(db).phase(binding, 'abandoned');
        journal.abandon(config.operationId);
        state.mark(config.operationId, 'abandoned');
        return {
          run: reportedRun ? { ...reportedRun, status: 'abandoned' as const } : null,
          mappings: status.mappings,
          execution: state.inspect(config.operationId),
        };
      },
    );
  }
  if (action === 'preflight' && status.run) throw new LibraryImportRefused('USE_RESUME_FOR_PARTIAL_IMPORT');
  if (action === 'run' && status.run) throw new LibraryImportRefused('USE_RESUME_FOR_PARTIAL_IMPORT');
  if (!status.run && ['resume', 'verify', 'rollback', 'abandon'].includes(action))
    throw new LibraryImportRefused('IMPORT_JOURNAL_MISSING');
  let bundle;
  try {
    bundle = status.run
      ? await loadRetainedLibraryImportBundle(db, config, source)
      : await loadLibraryImportBundle(config, source);
  } catch (error) {
    if (
      !(error instanceof LibraryImportRefused) ||
      action !== 'resume' ||
      !untouched ||
      local?.phase !== 'prepared' ||
      status.run?.status !== 'copying' ||
      ![
        'IMPORT_REVIEWED_INPUTS_MISSING',
        'IMPORT_PRIVATE_OWNERS_MISSING',
        'SOURCE_ARCHIVE_MISSING',
        'SOURCE_ARCHIVE_NOT_SEALED',
        'SOURCE_ARCHIVE_INCOMPLETE',
      ].includes(error.code)
    )
      throw error;
    if (error.code === 'SOURCE_ARCHIVE_INCOMPLETE') {
      const page = await new LibrarySourceArchive(db, {
        binding: status.run.binding,
        destinationId: config.destinationId,
      }).page();
      if (page.sealed) throw error;
    }
    bundle = await loadLibraryImportBundle(config, source);
    if (JSON.stringify(bundle.context.binding) !== JSON.stringify(status.run.binding))
      throw new LibraryImportRefused('IMPORT_BINDING_CHANGED');
  }
  const controller = new LibraryImportController(db, bundle.context);
  const inspect = async () => {
    await input.authorize(action, bundle.context);
    if (action === 'preflight' && config.bootstrapAdmin) {
      const { value } = await readPrivateImportJSON(config.bootstrapAdmin.path, 8192);
      await ensureImportBootstrapAdmin(db, value, {
        operationId: config.operationId,
        destinationId: config.destinationId,
        userId: config.bootstrapAdmin.userId,
        ownerIds: bundle.context.plan.owners.map(({ destinationId }) => destinationId.toLowerCase()),
        ownerEmails: bundle.owners.map(({ intent }) => intent.email.toLowerCase()),
      });
    }
    const report = await controller.preflight(bundle.owners);
    const { plan } = bundle.context;
    if (plan.version !== 2) throw new LibraryImportRefused('IMPORT_FILE_REVIEW_PLAN_VERSION');
    const reviewed = await reviewImportFiles(
      {
        ...plan,
        files: plan.files.map((file) => ({
          id: file.id,
          sourceAssetId: file.sourceAssetId,
          sourceFileId: file.sourceFileId,
          mode: file.mode,
          sourceRoot: file.sourceRoot,
          sourcePath: file.sourcePath,
          destinationRoot: file.destinationRoot,
          destinationPath: file.destinationPath,
          expectedBytes: file.bytes,
          expectedSha256: file.sha256,
        })),
      },
      'recheck',
    );
    if (importPlanSha256(reviewed) !== bundle.context.binding.planSha256)
      throw new LibraryImportRefused('IMPORT_PLAN_CHANGED');
    await bundle.assertUnchanged();
    await input.authorize(action, bundle.context);
    return { ...report, ...summarizeReviewedImport(bundle.context.manifest, plan) };
  };
  if (action === 'preflight') return withLibraryImportInspection(db, inspect);
  if (action === 'run' && !status.run) await withLibraryImportInspection(db, inspect);
  return withLibraryImportExecution(
    db,
    { binding: bundle.context.binding, destinationId: config.destinationId, identity: state.identity },
    (destinationNonce) =>
      executeLibraryImportAction({
        action,
        activate: input.activate,
        db,
        jobs: input.jobs,
        state,
        destinationNonce,
        bundle,
        manager: input.manager,
        authorize: (requested) => input.authorize(requested, bundle.context),
      }),
  );
}
