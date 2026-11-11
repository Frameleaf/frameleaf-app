import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { digest, Refusal, type Operation } from '../contracts.js';
import type { Store } from '../store.js';
import {
  NativeInstallationSchema,
  NativeCheckpointSchema,
  SecureInstallationIdSchema,
  type NativeInstallation,
  type NativeRuntime,
} from './native.js';
import { NativeRecovery } from './native-recovery.js';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const libraryId = z.string().regex(/^[a-f0-9]{12}$/);
const operationId = z
  .uuid()
  .refine((value) => value !== '00000000-0000-0000-0000-000000000000');
export const NativeMediaMoveBinding = z
  .object({
    moveId: operationId,
    secureInstallationId: SecureInstallationIdSchema,
    manifestSha256: sha256,
    libraryId,
    profileIdentity: sha256,
    sourceGeneration: operationId,
    sourceIdentity: sha256,
    targetIdentity: sha256,
    stagedIdentity: sha256,
    approvalSha256: sha256,
    copyReceiptSha256: sha256,
  })
  .strict()
  .refine(
    ({ sourceIdentity, targetIdentity, stagedIdentity }) =>
      new Set([sourceIdentity, targetIdentity, stagedIdentity]).size === 3,
  );

const MoveInput = z.strictObject({
  runtime: z.literal('native'),
  installationId: libraryId,
  fingerprint: sha256,
  binding: NativeMediaMoveBinding,
  decision: z.enum(['target', 'original']),
});

export const MediaMoveReviewRequest = z.strictObject({
  binding: NativeMediaMoveBinding,
  backupOperationId: operationId,
  decision: z.enum(['target', 'original']),
});

export const MediaMoveConfirmRequest = z.strictObject({
  reviewId: operationId,
  reviewSha256: sha256,
  key: operationId,
});

export const ReviewedMediaBackup = z.strictObject({
  snapshotId: sha256,
  recoverySha256: sha256,
  checkpoint: NativeCheckpointSchema.omit({ protocolVersion: true, state: true }),
});

const MediaMoveReview = MediaMoveReviewRequest.extend({
  reviewId: operationId,
  expiresAt: z.number().int().positive(),
  safety: ReviewedMediaBackup,
});

export type ReviewedMediaBackup = z.infer<typeof ReviewedMediaBackup>;

export interface NativeMediaAdmissionAuthority extends NativeMediaMoveAuthority {
  inspectAdmission(request: MoveRequest, backup: ReviewedMediaBackup): Promise<unknown>;
}

export function nativeMediaMoveAdmission(
  store: Store,
  owner: NativeMediaAdmissionAuthority,
  installation: NativeInstallation,
  library: string,
  admit: (key: string, input: z.infer<typeof MoveInput>) => Operation,
) {
  const reviewKey = (id: string) => `native-media-move-review:${id}`;

  function verifyBackup(backupId: string) {
    const operation = store.history().find(({ id }) => id === backupId);
    const verified = z.strictObject({ snapshotId: sha256, recovery: NativeRecovery })
      .safeParse(operation?.receipts['native-backup-verified']);
    if (
      operation?.kind !== 'backup' ||
      operation.state !== 'complete' ||
      !isDeepStrictEqual(operation.input, owner.identity) ||
      !operation.completed.includes('native-backup-verified') ||
      !operation.completed.includes('native-backup-owner-cleaned') ||
      !verified.success
    )
      throw new Refusal('native_media_backup_unverified');
    const { snapshotId, recovery } = verified.data;
    if (
      recovery.libraryId !== library ||
      recovery.installation.id !== installation.id ||
      recovery.checkpoint.operationId !== operation.id ||
      recovery.checkpoint.manifestSha256 !== installation.manifestSha256 ||
      recovery.checkpoint.sourceRevision !== installation.sourceRevision
    )
      throw new Refusal('native_media_backup_unverified');
    return {
      snapshotId,
      recoverySha256: digest(recovery),
      checkpoint: ReviewedMediaBackup.shape.checkpoint.parse(
        Object.fromEntries(Object.entries(recovery.checkpoint)
          .filter(([name]) => name !== 'protocolVersion' && name !== 'state')),
      ),
    };
  }

  async function check(review: z.infer<typeof MediaMoveReview>) {
    if (
      review.expiresAt <= Date.now() ||
      review.binding.libraryId !== library ||
      review.binding.secureInstallationId !== installation.secureInstallationId ||
      review.binding.manifestSha256 !== installation.manifestSha256 ||
      !isDeepStrictEqual(verifyBackup(review.backupOperationId), review.safety)
    )
      throw new Refusal('native_media_review_changed');
    const request = {
      protocolVersion: 1 as const,
      operationId: review.reviewId,
      binding: review.binding,
    };
    const selected = FencedSelection.safeParse(await owner.inspectAdmission(request, review.safety));
    if (
      !selected.success ||
      selected.data.operationId !== request.operationId ||
      !isDeepStrictEqual(selected.data.binding, request.binding)
    )
      throw new Refusal('native_media_cutover_unconfirmed');
  }

  return {
    safety: verifyBackup,
    async review(input: z.infer<typeof MediaMoveReviewRequest>, reviewId: string) {
      const safety = verifyBackup(input.backupOperationId);
      const review = MediaMoveReview.parse({
        ...input, reviewId, safety, expiresAt: Date.now() + 10 * 60_000,
      });
      await check(review);
      if (!store.createOnce(reviewKey(reviewId), review)) throw invalid();
      return { reviewId, reviewSha256: digest(review), decision: review.decision, expiresAt: review.expiresAt };
    },
    async confirm({ reviewId, reviewSha256, key }: z.infer<typeof MediaMoveConfirmRequest>) {
      const review = MediaMoveReview.safeParse(store.get(reviewKey(reviewId)));
      if (!review.success || review.data.reviewId !== reviewId || digest(review.data) !== reviewSha256)
        throw new Refusal('native_media_review_changed');
      const input = { ...owner.identity, binding: review.data.binding, decision: review.data.decision };
      const prior = store.request('move-library', key, input);
      if (prior) return prior;
      await check(review.data);
      if (review.data.expiresAt <= Date.now())
        throw new Refusal('native_media_review_changed');
      return admit(key, input);
    },
  };
}

const MoveRequest = z.strictObject({
  protocolVersion: z.literal(1),
  operationId,
  binding: NativeMediaMoveBinding,
});

const FencedSelection = MoveRequest.extend({
  state: z.literal('selected-fenced'),
  writerFence: z.literal('held'),
});

const Finalized = MoveRequest.extend({
  state: z.enum(['target-admitted', 'original-restored']),
  writerFence: z.literal('released'),
  activeMediaIdentity: sha256,
  generation: operationId,
});

export type MoveRequest = z.infer<typeof MoveRequest>;
export type FencedSelection = z.infer<typeof FencedSelection>;
type Finalized = z.infer<typeof Finalized>;
type Decision = z.infer<typeof MoveInput>['decision'];

/**
 * The protected Desktop owner authenticates its selected copy under the host writer lease.
 * It must persist the exact active media reference before releasing that fence, and
 * replay the same final receipt after a lost acknowledgement. Manager currently has
 * no installed authority implementing this interface.
 */
export interface NativeMediaMoveAuthority {
  readonly identity: NativeRuntime['identity'];
  inspect(request: MoveRequest, signal?: AbortSignal): Promise<unknown>;
  apply(
    selection: FencedSelection,
    decision: Decision,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

const intentKey = 'native-media-cutover-intent';
const resultKey = 'native-media-cutover-receipt';
const startupKey = 'native-media-cutover-startup';
const activeMediaKey = (installation: NativeInstallation) =>
  `native-active-media:${installation.secureInstallationId}`;

export function nativeActiveMediaIdentity(
  store: Store,
  installation: NativeInstallation,
): string | undefined {
  const value = store.get(activeMediaKey(installation));
  if (value === null) return undefined;
  const parsed = sha256.safeParse(value);
  if (!parsed.success) throw new Refusal('native_media_cutover_journal_invalid');
  return parsed.data;
}

const invalid = () => new Refusal('native_media_cutover_journal_invalid');

/** Reconcile the writer-fenced move without releasing Manager's operation lock. */
export async function runNativeMediaCutover(
  store: Store,
  owner: NativeMediaMoveAuthority,
  installation: NativeInstallation,
  operation: Operation,
  signal?: AbortSignal,
): Promise<Finalized> {
  const descriptor = NativeInstallationSchema.safeParse(installation);
  const parsed = MoveInput.safeParse(operation.input);
  const managerOperation = operationId.safeParse(operation.id);
  if (!descriptor.success || !parsed.success || !managerOperation.success)
    throw invalid();
  const { binding, decision, ...identity } = parsed.data;
  const request: MoveRequest = {
    protocolVersion: 1,
    operationId: managerOperation.data,
    binding,
  };
  if (
    identity.installationId !== descriptor.data.id ||
    identity.fingerprint !== digest(descriptor.data) ||
    binding.secureInstallationId !== descriptor.data.secureInstallationId ||
    binding.manifestSha256 !== descriptor.data.manifestSha256
  )
    throw invalid();

  function owned() {
    if (
      operation.kind !== 'move-library' ||
      operation.state !== 'running' ||
      !isDeepStrictEqual(operation.input, parsed.data) ||
      !isDeepStrictEqual(owner.identity, identity) ||
      store.get('native-library-id') !== binding.libraryId ||
      !isDeepStrictEqual(store.locked(), operation)
    )
      throw invalid();
    if (signal?.aborted) throw new Refusal('native_media_cutover_cancelled');
  }

  function record(key: string, receipt: unknown) {
    owned();
    operation.step = key;
    operation.receipts[key] = receipt;
    operation.completed.push(key);
    store.save(operation);
  }

  function matchesRequest(value: MoveRequest): boolean {
    return (
      value.operationId === request.operationId &&
      isDeepStrictEqual(value.binding, request.binding)
    );
  }

  function finalReceipt(value: unknown): Finalized {
    const result = Finalized.safeParse(value);
    if (!result.success) throw new Refusal('native_media_cutover_unconfirmed');
    const { state, activeMediaIdentity, generation } = result.data;
    const target = decision === 'target';
    if (
      !matchesRequest(result.data) ||
      state !== (target ? 'target-admitted' : 'original-restored') ||
      activeMediaIdentity !==
        (target ? binding.stagedIdentity : binding.sourceIdentity) ||
      (target
        ? generation === binding.sourceGeneration
        : generation !== binding.sourceGeneration)
    )
      throw new Refusal('native_media_cutover_unconfirmed');
    return result.data;
  }

  owned();
  const intent = { request, decision };
  const previousIntent = operation.receipts[intentKey];
  const previousResult = operation.receipts[resultKey];
  if (
    operation.completed.includes(intentKey) !== (previousIntent !== undefined) ||
    operation.completed.includes(resultKey) !== (previousResult !== undefined) ||
    (previousIntent !== undefined && !isDeepStrictEqual(previousIntent, intent)) ||
    (previousResult !== undefined && previousIntent === undefined)
  )
    throw invalid();

  // A journaled receipt predates startup. Once the host runs, its source generation
  // can no longer be inspected through the quiescent controller.
  if (previousResult !== undefined) return finalReceipt(previousResult);

  const current = await owner.inspect(request, signal);
  owned();
  const selected = FencedSelection.safeParse(current);
  let receipt: Finalized;
  if (selected.success) {
    if (!matchesRequest(selected.data))
      throw new Refusal('native_media_cutover_unconfirmed');
    if (previousIntent === undefined) record(intentKey, intent);
    receipt = finalReceipt(await owner.apply(selected.data, decision, signal));
  } else {
    if (previousIntent === undefined)
      throw new Refusal('native_media_cutover_unconfirmed');
    receipt = finalReceipt(current);
  }

  owned();
  record(resultKey, receipt);
  return receipt;
}


/** Finish only a previously admitted private operation. The lifecycle releases its lock on return. */
export async function completeNativeMediaCutover(
  store: Store,
  owner: NativeMediaMoveAuthority,
  installation: NativeInstallation,
  operation: Operation,
  start: NativeRuntime['start'],
): Promise<void> {
  const receipt = await runNativeMediaCutover(
    store,
    owner,
    installation,
    operation,
  );
  if (!isDeepStrictEqual(store.locked(), operation)) throw invalid();
  const expected =
    receipt.state === 'target-admitted' ? receipt.activeMediaIdentity : undefined;
  const recorded = nativeActiveMediaIdentity(store, installation);
  if (recorded !== undefined && recorded !== expected) throw invalid();
  // Persist the expected target before any startup. Ordinary starts after Manager
  // recovery also require that identity, including after the move operation completes.
  if (
    expected !== undefined &&
    recorded === undefined &&
    !store.createOnce(activeMediaKey(installation), expected)
  )
    throw invalid();

  const ready = await start();
  if (
    ready.protocolVersion !== 1 ||
    ready.state !== 'running' ||
    ready.secureInstallationId !== installation.secureInstallationId ||
    ready.manifestSha256 !== installation.manifestSha256 ||
    ready.sourceRevision !== installation.sourceRevision ||
    ready.certified !== installation.certified ||
    ready.activeMediaIdentity !== expected
  )
    throw new Refusal('native_media_startup_unconfirmed');
  if (!isDeepStrictEqual(store.locked(), operation)) throw invalid();
  operation.step = startupKey;
  operation.receipts[startupKey] = ready;
  if (!operation.completed.includes(startupKey)) operation.completed.push(startupKey);
  store.save(operation);
}
