import { createHash } from 'node:crypto';
import { type ImportDatabase } from 'src/immich-import/types.js';
import { type loadLibraryImportBundle } from 'src/library-import/bundle-input.js';
import { LibraryImportController } from 'src/library-import/controller.js';
import { type ManagerLibrarySetup, libraryImportDerivedRunId } from 'src/library-import/derived-work.js';
import { type LocalLibraryImportState } from 'src/library-import/local-transfer-state.js';
import { LibraryImportRefused } from 'src/library-import/state.js';
import {
  adoptImportFiles,
  assertImportDestinations,
  copyImportFiles,
  importPlanSha256,
  relocateImportFiles,
  rollbackImportRelocations,
} from 'src/library-import/transfer-runtime.js';
import { type JobRepository } from 'src/repositories/job.repository.js';

type Action = 'run' | 'resume' | 'verify' | 'rollback' | 'abandon';
type Bundle = Omit<Awaited<ReturnType<typeof loadLibraryImportBundle>>, 'records' | 'assertUnchanged'> & {
  records: () => AsyncIterable<unknown> | Iterable<unknown>;
  assertUnchanged: (destinationSession?: ImportDatabase) => Promise<void>;
};
const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};

/** Caller holds the process/session execution locks and qualifies live source fencing, schema, privacy and storage. */
export async function executeLibraryImportAction(input: {
  action: Action;
  activate?: boolean;
  db: ImportDatabase;
  jobs: JobRepository;
  state: LocalLibraryImportState;
  destinationNonce: string;
  bundle: Bundle;
  manager?: ManagerLibrarySetup;
  authorize: (action: Action) => Promise<void>;
}) {
  const { action, bundle, state, db, jobs, manager } = input;
  const { context } = bundle,
    { binding, plan } = context,
    operationId = binding.operationId;
  const controller = new LibraryImportController(db, context);
  const initial = await controller.status();
  const local = state.inspect(operationId);
  const finish = async () => ({ ...(await controller.status()), execution: state.inspect(operationId) });
  if (input.activate && action !== 'verify') return refuse('IMPORT_ACTIVATION_REQUIRES_VERIFY');
  if ((local?.writersMayHaveStarted || initial.run?.status === 'activated') && action !== 'verify')
    return refuse('IMPORT_POST_ACTIVATION_RECOVERY_REQUIRED');
  const roots = Object.fromEntries(plan.roots.map((root) => [root.id, root]));
  const bind = () =>
    state.bind(operationId, {
      binding,
      destinationId: context.destinationId,
      destinationNonce: input.destinationNonce,
    });

  if (initial.run?.status === 'activated') {
    if (!local?.writersMayHaveStarted || local.abandoned) return refuse('IMPORT_LOCAL_ACTIVATION_EVIDENCE_MISSING');
    const journal = bind(),
      review = journal.review(operationId);
    if (
      !review.plan ||
      importPlanSha256(review.plan) !== binding.planSha256 ||
      review.verification?.manifestSha256 !== binding.manifestSha256 ||
      review.verification.planSha256 !== binding.planSha256 ||
      review.verification.regenerationRunId !== libraryImportDerivedRunId(binding)
    )
      return refuse('IMPORT_LOCAL_ACTIVATION_EVIDENCE_MISSING');
    await assertImportDestinations(journal, operationId, roots);
    const activation = await controller.activate(jobs, bundle.assertUnchanged, manager);
    state.mark(operationId, 'activated');
    return { ...(await finish()), activation };
  }
  if (local?.writersMayHaveStarted && (!input.activate || action !== 'verify'))
    return refuse('IMPORT_POST_ACTIVATION_RECOVERY_REQUIRED');
  if (initial.run?.status === 'abandoned' && action !== 'rollback' && action !== 'abandon')
    return refuse('ABANDONED_DESTINATION_REQUIRES_FRESH_DATABASE');
  if ((action === 'rollback' || action === 'abandon') && local?.abandoned) {
    if (initial.run?.status !== 'abandoned') return refuse('IMPORT_PHASE_CHANGED');
    return finish();
  }
  if (action === 'run' && initial.run) return refuse('USE_RESUME_FOR_PARTIAL_IMPORT');
  if (action === 'resume' && !initial.run) return refuse('NO_IMPORT_TO_RESUME');
  if (action === 'verify' && initial.run?.status !== 'verifying') return refuse('IMPORT_NOT_VERIFYING');
  if ((action === 'run' || action === 'resume') && local && !['prepared', 'copying', 'verifying'].includes(local.phase))
    return refuse('IMPORT_PHASE_CHANGED');
  // Moving one inode cannot invalidate another reviewed placement, including a different source file ID.
  const physical = new Map<string, { count: number; relocate: boolean }>();
  for (const file of plan.files) {
    const key = `${file.sourceIdentity.device}:${file.sourceIdentity.inode}`;
    const previous = physical.get(key) ?? { count: 0, relocate: false };
    previous.count++;
    previous.relocate ||= file.mode === 'relocate';
    if (previous.relocate && previous.count > 1) return refuse('IMPORT_SHARED_ORIGINAL_RELOCATION_REQUIRES_REVIEW');
    physical.set(key, previous);
  }
  await input.authorize(action);
  const journal = bind();
  journal.begin(operationId, { manifestSha256: binding.manifestSha256, planSha256: binding.planSha256 });

  if (action === 'rollback' || action === 'abandon') {
    if (
      action === 'abandon' &&
      journal
        .files(operationId)
        .some(({ file, state }) => file.mode === 'relocate' && state !== 'rolled-back' && state !== 'cancelled')
    )
      return refuse('IMPORT_ROLLBACK_REQUIRED');
    if (action === 'rollback') {
      state.mark(operationId, 'rolling-back');
      await rollbackImportRelocations(journal, operationId, roots);
    }
    if (initial.run) await controller.abandon();
    journal.abandon(operationId);
    state.mark(operationId, 'abandoned');
    return finish();
  }
  if (action === 'run' || action === 'resume') {
    journal.sealPlan(operationId, plan);
    if (initial.run?.status !== 'verifying')
      await controller.prepare(bundle.owners, bundle.descriptor, bundle.records());
    state.mark(operationId, 'copying');
    for (const file of plan.files) journal.intent(operationId, file);
    await copyImportFiles(journal, operationId, roots, action === 'resume');
    await adoptImportFiles(journal, operationId, roots);
    await relocateImportFiles(journal, operationId, roots, action === 'resume');
    await assertImportDestinations(journal, operationId, roots);
    await bundle.assertUnchanged();
    await controller.resume(bundle.owners, bundle.descriptor, bundle.records());
    state.mark(operationId, 'verifying');
    return finish();
  }

  await assertImportDestinations(journal, operationId, roots);
  const assertSourceUnchanged = async (session?: ImportDatabase) => {
    await input.authorize('verify');
    await bundle.assertUnchanged(session);
  };
  if (!local?.writersMayHaveStarted) {
    const report = await controller.verify();
    await assertSourceUnchanged();
    const runId = await jobs.dispatchImportedLibraryWork(context, manager);
    if (runId !== libraryImportDerivedRunId(binding)) return refuse('DERIVED_RUN_IDENTITY_MISMATCH');
    // These digests are certified only after each reconciler independently matches expected and destination records.
    const compared = (...digests: string[]) => {
      const sha256 = createHash('sha256').update(JSON.stringify(digests)).digest('hex');
      return { expectedSha256: sha256, actualSha256: sha256 };
    };
    journal.recordVerification(operationId, {
      manifestSha256: binding.manifestSha256,
      planSha256: binding.planSha256,
      records: compared(report.owners.sha256, report.assets.sha256, report.archive.sha256),
      relationships: compared(report.albums.sha256, report.stacks.sha256),
      permissions: compared(report.owners.sha256, report.albums.sha256),
      regenerationRunId: runId,
    });
    if (!input.activate) return { ...(await finish()), verification: report };
  } else if (!journal.review(operationId).verification) return refuse('IMPORT_LOCAL_ACTIVATION_EVIDENCE_MISSING');
  await assertSourceUnchanged();
  if (!local?.writersMayHaveStarted) journal.writersStarting(operationId);
  state.mark(operationId, 'activating');
  const activation = await controller.activate(jobs, assertSourceUnchanged, manager);
  state.mark(operationId, 'activated');
  return { ...(await finish()), activation };
}
