import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { digest, Refusal, type Operation } from '../contracts.js';
import type { Store } from '../store.js';
import {
  NativeInstallationSchema,
  SecureInstallationIdSchema,
  type NativeInstallation,
  type NativeRuntime,
} from './native.js';

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

type MoveRequest = z.infer<typeof MoveRequest>;
type FencedSelection = z.infer<typeof FencedSelection>;
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

  const current = await owner.inspect(request, signal);
  owned();
  const selected = FencedSelection.safeParse(current);
  let receipt: Finalized;
  if (selected.success) {
    if (previousResult !== undefined || !matchesRequest(selected.data))
      throw new Refusal('native_media_cutover_unconfirmed');
    if (previousIntent === undefined) record(intentKey, intent);
    receipt = finalReceipt(await owner.apply(selected.data, decision, signal));
  } else {
    if (previousIntent === undefined)
      throw new Refusal('native_media_cutover_unconfirmed');
    receipt = finalReceipt(current);
  }

  owned();
  if (previousResult === undefined) record(resultKey, receipt);
  else if (!isDeepStrictEqual(previousResult, receipt))
    throw new Refusal('native_media_cutover_unconfirmed');
  // Starting the host and checking its reported media identity remain separate.
  return receipt;
}
