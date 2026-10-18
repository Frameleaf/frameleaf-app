import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { digest, Refusal, type Operation } from '../contracts.js';
import { Store } from '../store.js';
import {
  NativeRestoreInputBinding,
  NativeRestorePreparedSchema,
  NativeRestoreVerifiedSchema,
  NativeRestoreSelectionSchema,
  NativeRestoreFinalizedSchema,
  NativeRestoreReply,
  type NativeRestoreBinding,
  type NativeRestorePrepared,
  type NativeRestoreVerified,
  type NativeRestoreSelection,
  type NativeRestoreFinalized,
} from './native-restore-contract.js';

const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const Installation = z
  .object({
    runtime: z.literal('native'),
    id: z.string().regex(/^[a-f0-9]{12}$/),
    controller: localPath,
    candidate: localPath,
    state: localPath,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    certified: z.boolean(),
    databasePort: z.number().int().min(1).max(65535),
    apiPort: z.number().int().min(1).max(65535),
  })
  .strict()
  .refine((value) => value.databasePort !== value.apiPort);
export type NativeInstallation = z.infer<typeof Installation>;
export { Installation as NativeInstallationSchema };
const Running = z
  .object({
    protocolVersion: z.literal(1),
    state: z.literal('running'),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    certified: z.boolean(),
  })
  .strict();
const DatabaseReady = Running.extend({
  state: z.literal('database-ready'),
}).strict();
type DatabaseReceipt = z.infer<typeof DatabaseReady>;
const CleanupReady = Running.extend({
  state: z.literal('checkpoint-cleanup-ready'),
}).strict();
type CleanupReceipt = z.infer<typeof CleanupReady>;
const RestoreReady = Running.extend({
  state: z.literal('restore-prepare-ready'),
}).strict();
type RestoreReceipt = z.infer<typeof RestoreReady>;
const Stopped = z
  .object({ protocolVersion: z.literal(1), state: z.literal('stopped') })
  .strict();
const Failed = z
  .object({
    protocolVersion: z.literal(1),
    state: z.literal('failed'),
    code: z.string().min(1).max(128),
  })
  .strict();
const checkpointOperation = z
  .string()
  .regex(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
const Checkpoint = z
  .object({
    protocolVersion: z.literal(1),
    state: z.literal('checkpoint'),
    schemaVersion: z.literal(1),
    operationId: checkpointOperation,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    postgresMajor: z.literal('19'),
    databaseFormat: z.literal('frameleaf-canonical'),
    dump: z
      .object({
        bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .strict();
const RestoreSafety = z
  .object({
    snapshotId: z.string().regex(/^[a-f0-9]{64}$/),
    recoverySha256: z.string().regex(/^[a-f0-9]{64}$/),
    checkpoint: Checkpoint,
  })
  .strict();
export type NativeRestoreSafety = z.infer<typeof RestoreSafety>;
const CheckpointFailed = z
  .object({
    protocolVersion: z.literal(1),
    state: z.literal('checkpoint-failed'),
    operationId: checkpointOperation,
    code: z.literal('host_checkpoint_failed'),
  })
  .strict();
const CheckpointCleaned = Checkpoint.extend({
  state: z.literal('checkpoint-cleaned'),
}).strict();
const CheckpointCleanupFailed = CheckpointFailed.extend({
  state: z.literal('checkpoint-cleanup-failed'),
  code: z.literal('host_checkpoint_cleanup_failed'),
}).strict();
const CheckpointReply = z.discriminatedUnion('state', [
  Checkpoint,
  CheckpointFailed,
  CheckpointCleaned,
  CheckpointCleanupFailed,
]);
type NativeCheckpointCleaned = z.infer<typeof CheckpointCleaned>;

export type NativeCheckpoint = z.infer<typeof Checkpoint>;
export { Checkpoint as NativeCheckpointSchema };
const Quiescent = Running.omit({ state: true })
  .extend({
    state: z.literal('quiescent'),
    installationId: z.string().regex(/^[a-f0-9]{12}$/),
    profileIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.string().uuid(),
  })
  .strict();
type Ready = z.infer<typeof Running>;
type StopReceipt = z.infer<typeof Stopped> & {
  inspection?: z.infer<typeof Quiescent>;
};
/** Cold inspection carries the same stop proof plus a strictly bound runtime identity. */
export function nativeStopped(
  value: unknown,
  installation: NativeInstallation,
): StopReceipt {
  const parsed = Stopped.extend({ inspection: Quiescent.optional() })
    .strict()
    .safeParse(value);
  const inspection = parsed.success ? parsed.data.inspection : undefined;
  if (
    !parsed.success ||
    (inspection &&
      (inspection.installationId !== installation.id ||
        inspection.manifestSha256 !== installation.manifestSha256 ||
        inspection.sourceRevision !== installation.sourceRevision ||
        inspection.certified !== installation.certified))
  )
    throw new Refusal('native_shutdown_unconfirmed');
  return parsed.data;
}
export interface NativeRuntime {
  readonly identity: Readonly<{
    runtime: 'native';
    installationId: string;
    fingerprint: string;
  }>;
  status(): {
    state: 'unknown' | 'starting' | 'running' | 'stopping' | 'stopped';
    code?: string;
  };
  start(): Promise<Ready>;
  startDatabase(): Promise<DatabaseReceipt>;
  startCheckpointCleanup(): Promise<CleanupReceipt>;
  startRestorePreparation(): Promise<RestoreReceipt>;
  prepareRestore(
    binding: NativeRestoreBinding,
    signal?: AbortSignal,
  ): Promise<NativeRestorePrepared>;
  verifyRestore(
    prepared: NativeRestorePrepared,
    signal?: AbortSignal,
  ): Promise<NativeRestoreVerified>;
  selectRestore(
    proof: NativeRestoreVerified,
    safety: NativeRestoreSafety,
    signal?: AbortSignal,
  ): Promise<NativeRestoreSelection>;
  finalizeRestore(
    proof: NativeRestoreVerified,
    safety: NativeRestoreSafety,
    signal?: AbortSignal,
  ): Promise<NativeRestoreFinalized>;
  stop(): Promise<StopReceipt>;
  checkpoint(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<NativeCheckpoint>;
  cleanupCheckpoint(
    checkpoint: NativeCheckpoint,
    signal?: AbortSignal,
  ): Promise<NativeCheckpointCleaned>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Either side may fail before its caller starts waiting; the promise still retains that failure.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type Owner = {
  child: ChildProcessWithoutNullStreams | null;
  mode: 'server' | 'database' | 'checkpoint-cleanup' | 'restore-prepare';
  ready: ReturnType<
    typeof deferred<Ready | DatabaseReceipt | CleanupReceipt | RestoreReceipt>
  >;
  closed: ReturnType<typeof deferred<StopReceipt>>;
  readySeen: boolean;
  stoppedSeen: boolean;
  stopping: boolean;
  finished: boolean;
  fault: Refusal | null;
  startupTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
  verificationIds: Set<string>;
  verifiedRestore?: NativeRestoreVerified;
  selection?: {
    operationId: string;
    state: 'restore-activation-pending' | 'restore-finalized';
    receipt?: NativeRestoreSelection | NativeRestoreFinalized;
    work: ReturnType<
      typeof deferred<NativeRestoreSelection | NativeRestoreFinalized>
    >;
    cleanup: () => void;
  };
  restore?: {
    prepared?: Omit<NativeRestorePrepared, 'protocolVersion'>;
    binding: NativeRestoreBinding;
    work: ReturnType<
      typeof deferred<NativeRestorePrepared | NativeRestoreVerified>
    >;
    cleanup: () => void;
  };
  checkpoint?: {
    operationId: string;
    work: ReturnType<
      typeof deferred<NativeCheckpoint | NativeCheckpointCleaned>
    >;
    expected?: NativeCheckpoint;
    cleanup: () => void;
  };
};

/** The descriptor comes from reviewed installed resources, never a photo-server response or webview. */
export class NativeHost implements NativeRuntime {
  readonly installation: Readonly<NativeInstallation>;
  readonly identity: NativeRuntime['identity'];
  private owner: Owner | null = null;
  private inspecting: Promise<StopReceipt> | null = null;
  private observed:
    { state: 'stopped' } | { state: 'unknown'; code: string } | null = null;
  constructor(
    installation: NativeInstallation,
    private password: () => Promise<string>,
    private authorizeController: () => Promise<void> = async () => {},
  ) {
    const parsed = Installation.safeParse(installation);
    if (!parsed.success) throw new Refusal('native_installation_invalid');
    this.installation = Object.freeze(parsed.data);
    this.identity = Object.freeze({
      runtime: 'native',
      installationId: parsed.data.id,
      fingerprint: digest(parsed.data),
    });
  }
  start(): Promise<Ready> {
    return this.startOwner('server') as Promise<Ready>;
  }
  startDatabase(): Promise<DatabaseReceipt> {
    return this.startOwner('database') as Promise<DatabaseReceipt>;
  }
  startCheckpointCleanup(): Promise<CleanupReceipt> {
    return this.startOwner('checkpoint-cleanup') as Promise<CleanupReceipt>;
  }
  startRestorePreparation(): Promise<RestoreReceipt> {
    return this.startOwner('restore-prepare') as Promise<RestoreReceipt>;
  }
  prepareRestore(
    input: NativeRestoreBinding,
    signal?: AbortSignal,
  ): Promise<NativeRestorePrepared> {
    return this.requestRestore(
      input,
      undefined,
      signal,
    ) as Promise<NativeRestorePrepared>;
  }
  verifyRestore(
    input: NativeRestorePrepared,
    signal?: AbortSignal,
  ): Promise<NativeRestoreVerified> {
    const parsed = NativeRestorePreparedSchema.safeParse(input);
    if (!parsed.success)
      return Promise.reject(new Refusal('native_restore_request_invalid'));
    // The protocol version belongs only to the outer controller envelope.
    const { protocolVersion, ...prepared } = parsed.data;
    return this.requestRestore(
      prepared.binding,
      prepared,
      signal,
    ) as Promise<NativeRestoreVerified>;
  }
  private requestRestore(
    input: NativeRestoreBinding,
    prepared: Omit<NativeRestorePrepared, 'protocolVersion'> | undefined,
    signal?: AbortSignal,
  ): Promise<NativeRestorePrepared | NativeRestoreVerified> {
    const parsed = NativeRestoreInputBinding.safeParse(input);
    if (
      !parsed.success ||
      !checkpointOperation.safeParse(parsed.data.operationId).success ||
      !checkpointOperation.safeParse(parsed.data.reviewId).success ||
      parsed.data.installationId !== this.installation.id ||
      parsed.data.manifestSha256 !== this.installation.manifestSha256 ||
      parsed.data.sourceRevision !== this.installation.sourceRevision
    )
      return Promise.reject(new Refusal('native_restore_request_invalid'));
    if (signal?.aborted)
      return Promise.reject(new Refusal('native_restore_cancelled'));
    const owner = this.owner;
    if (
      !owner?.child ||
      owner.mode !== 'restore-prepare' ||
      !owner.readySeen ||
      owner.stopping ||
      owner.finished ||
      owner.fault
    )
      return Promise.reject(new Refusal('native_restore_unavailable'));
    if (owner.restore || owner.checkpoint || owner.selection)
      return Promise.reject(new Refusal('native_restore_busy'));
    owner.verifiedRestore = undefined;
    const binding = parsed.data,
      work = deferred<NativeRestorePrepared | NativeRestoreVerified>();
    const abort = () => this.stopOwner(owner);
    const timer = setTimeout(() => {
      owner.fault ??= new Refusal('native_restore_timeout');
      this.stopOwner(owner);
    }, 7_200_000);
    timer.unref();
    owner.restore = {
      binding,
      prepared,
      work,
      cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      },
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      owner.child.stdin.write(
        JSON.stringify({
          protocolVersion: 1,
          action: prepared ? 'verify-restore' : 'prepare-restore',
          operationId: binding.operationId,
          ...(prepared ? { prepared } : { binding }),
        }) + '\n',
      );
    } catch {
      owner.fault ??= new Refusal('native_host_pipe_failed');
      this.stopOwner(owner);
    }
    return work.promise;
  }
  selectRestore(
    input: NativeRestoreVerified,
    snapshot: NativeRestoreSafety,
    signal?: AbortSignal,
  ): Promise<NativeRestoreSelection> {
    return this.requestSelection(input, snapshot, false, signal).then((value) =>
      NativeRestoreSelectionSchema.parse(value),
    );
  }
  finalizeRestore(
    input: NativeRestoreVerified,
    snapshot: NativeRestoreSafety,
    signal?: AbortSignal,
  ): Promise<NativeRestoreFinalized> {
    return this.requestSelection(input, snapshot, true, signal).then((value) =>
      NativeRestoreFinalizedSchema.parse(value),
    );
  }
  private requestSelection(
    input: NativeRestoreVerified,
    snapshot: NativeRestoreSafety,
    finalize: boolean,
    signal?: AbortSignal,
  ): Promise<NativeRestoreSelection | NativeRestoreFinalized> {
    const proof = NativeRestoreVerifiedSchema.safeParse(input),
      safety = RestoreSafety.safeParse(snapshot);
    if (
      !proof.success ||
      !safety.success ||
      safety.data.checkpoint.operationId !==
        proof.data.prepared.binding.operationId ||
      safety.data.checkpoint.manifestSha256 !==
        this.installation.manifestSha256 ||
      safety.data.checkpoint.sourceRevision !== this.installation.sourceRevision
    )
      return Promise.reject(new Refusal('native_restore_request_invalid'));
    if (signal?.aborted)
      return Promise.reject(new Refusal('native_restore_cancelled'));
    const owner = this.owner;
    if (
      !owner?.child ||
      owner.mode !== 'restore-prepare' ||
      !owner.readySeen ||
      owner.stopping ||
      owner.finished ||
      owner.fault
    )
      return Promise.reject(new Refusal('native_restore_unavailable'));
    if (owner.restore || owner.checkpoint || owner.selection)
      return Promise.reject(new Refusal('native_restore_busy'));
    if (!isDeepStrictEqual(owner.verifiedRestore, proof.data))
      return Promise.reject(new Refusal('native_restore_proof_invalid'));
    owner.verifiedRestore = undefined;
    const work = deferred<NativeRestoreSelection | NativeRestoreFinalized>(),
      operationId = proof.data.prepared.binding.operationId;
    const abort = () => this.stopOwner(owner);
    const timer = setTimeout(() => {
      owner.fault ??= new Refusal('native_restore_timeout');
      this.stopOwner(owner);
      owner.child?.kill();
    }, 7_200_000);
    timer.unref();
    owner.selection = {
      operationId,
      state: finalize ? 'restore-finalized' : 'restore-activation-pending',
      work,
      cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      },
    };
    signal?.addEventListener('abort', abort, { once: true });
    const { protocolVersion, state, ...checkpoint } = safety.data.checkpoint;
    try {
      owner.child.stdin.write(
        JSON.stringify({
          protocolVersion: 1,
          action: finalize ? 'finalize-restore' : 'select-restore',
          operationId,
          verificationId: proof.data.verificationId,
          safety: { ...safety.data, checkpoint },
        }) + '\n',
      );
    } catch {
      owner.fault ??= new Refusal('native_host_pipe_failed');
      this.stopOwner(owner);
    }
    return work.promise;
  }
  private startOwner(
    mode: 'server' | 'database' | 'checkpoint-cleanup' | 'restore-prepare',
  ): Promise<Ready | DatabaseReceipt | CleanupReceipt | RestoreReceipt> {
    if (this.inspecting)
      return Promise.reject(new Refusal('native_runtime_busy'));
    if (this.owner && !this.owner.finished) {
      if (this.owner.stopping || this.owner.mode !== mode)
        return Promise.reject(new Refusal('native_runtime_busy'));
      return this.owner.ready.promise;
    }
    const owner: Owner = {
      child: null,
      mode,
      ready: deferred<
        Ready | DatabaseReceipt | CleanupReceipt | RestoreReceipt
      >(),
      closed: deferred<StopReceipt>(),
      readySeen: false,
      stoppedSeen: false,
      stopping: false,
      finished: false,
      fault: null,
      verificationIds: new Set(),
    };
    this.observed = null;
    this.owner = owner;
    void this.launch(owner).catch(() => {
      owner.fault ??= new Refusal('native_controller_unavailable');
      if (owner.child) this.stopOwner(owner);
      else this.finish(owner);
    });
    return owner.ready.promise;
  }
  stop(): Promise<StopReceipt> {
    if (!this.owner || this.owner.finished) return this.inspect();
    if (!this.owner.finished) this.stopOwner(this.owner);
    return this.owner.closed.promise;
  }
  checkpoint(
    operationId: string,
    signal?: AbortSignal,
  ): Promise<NativeCheckpoint> {
    return this.requestCheckpoint(operationId, signal).then((value) =>
      Checkpoint.parse(value),
    );
  }
  cleanupCheckpoint(
    checkpoint: NativeCheckpoint,
    signal?: AbortSignal,
  ): Promise<NativeCheckpointCleaned> {
    const parsed = Checkpoint.safeParse(checkpoint);
    if (
      !parsed.success ||
      parsed.data.manifestSha256 !== this.installation.manifestSha256 ||
      parsed.data.sourceRevision !== this.installation.sourceRevision
    )
      return Promise.reject(new Refusal('native_checkpoint_request_invalid'));
    return this.requestCheckpoint(
      parsed.data.operationId,
      signal,
      parsed.data,
    ).then((value) => CheckpointCleaned.parse(value));
  }
  private requestCheckpoint(
    operationId: string,
    signal?: AbortSignal,
    expected?: NativeCheckpoint,
  ): Promise<NativeCheckpoint | NativeCheckpointCleaned> {
    if (!checkpointOperation.safeParse(operationId).success)
      return Promise.reject(new Refusal('native_checkpoint_request_invalid'));
    if (signal?.aborted)
      return Promise.reject(new Refusal('native_checkpoint_cancelled'));
    const owner = this.owner;
    if (
      owner?.mode === 'restore-prepare' ||
      (owner?.mode === 'checkpoint-cleanup' && !expected) ||
      !owner?.child ||
      !owner.readySeen ||
      owner.stopping ||
      owner.finished ||
      owner.fault
    )
      return Promise.reject(new Refusal('native_checkpoint_unavailable'));
    if (owner.checkpoint || owner.restore)
      return Promise.reject(new Refusal('native_checkpoint_busy'));
    const work = deferred<NativeCheckpoint | NativeCheckpointCleaned>();
    const abort = () => this.stopOwner(owner);
    const timer = setTimeout(() => {
      owner.fault ??= new Refusal('native_checkpoint_timeout');
      this.stopOwner(owner);
    }, 7_200_000);
    timer.unref();
    owner.checkpoint = {
      operationId,
      work,
      expected,
      cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      },
    };
    signal?.addEventListener('abort', abort, { once: true });
    let checkpoint;
    if (expected) {
      const { protocolVersion: _version, state: _state, ...receipt } = expected;
      checkpoint = receipt;
    }
    try {
      owner.child.stdin.write(
        JSON.stringify({
          protocolVersion: 1,
          action: expected ? 'cleanup-checkpoint' : 'checkpoint',
          operationId,
          ...(checkpoint ? { checkpoint } : {}),
        }) + '\n',
      );
    } catch {
      owner.fault ??= new Refusal('native_host_pipe_failed');
      this.stopOwner(owner);
    }
    return work.promise;
  }
  status(): {
    state: 'unknown' | 'starting' | 'running' | 'stopping' | 'stopped';
    code?: string;
  } {
    const owner = this.owner;
    if (this.inspecting)
      return { state: 'unknown', code: 'native_state_inspecting' };
    if ((!owner || owner.finished) && this.observed) return this.observed;
    if (!owner) return { state: 'unknown', code: 'native_owner_not_attached' };
    if (owner.fault) return { state: 'unknown', code: owner.fault.code };
    if (owner.finished) return { state: 'stopped' };
    if (owner.mode === 'restore-prepare' && !owner.stopping)
      return { state: 'unknown', code: 'native_restore_maintenance' };
    if (owner.mode === 'checkpoint-cleanup' && !owner.stopping)
      return {
        state: 'unknown',
        code: 'native_checkpoint_cleanup_maintenance',
      };
    if (owner.mode === 'database' && !owner.stopping)
      return { state: 'unknown', code: 'native_database_maintenance' };
    return {
      state: owner.stopping
        ? 'stopping'
        : owner.readySeen
          ? 'running'
          : 'starting',
    };
  }
  private inspect(): Promise<StopReceipt> {
    if (this.inspecting) return this.inspecting;
    this.observed = null;
    const work = this.probe()
      .then((receipt) => {
        this.observed = { state: 'stopped' };
        return receipt;
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof Refusal
            ? error
            : new Refusal('native_host_inspection_failed');
        this.observed = { state: 'unknown', code: failure.code };
        throw failure;
      })
      .finally(() => {
        this.inspecting = null;
      });
    this.inspecting = work;
    void work.catch(() => {});
    return work;
  }
  private async probe(): Promise<StopReceipt> {
    await this.authorizeController();
    const { id, candidate, state, manifestSha256 } = this.installation;
    const wire =
      JSON.stringify({
        protocolVersion: 1,
        installationId: id,
        candidate,
        state,
        manifestSha256,
      }) + '\n';
    if (Buffer.byteLength(wire) > 16 * 1024)
      return Promise.reject(new Refusal('native_installation_invalid'));
    return new Promise((resolve, reject) => {
      const env =
        process.platform === 'win32' && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {};
      const child = spawn(this.installation.controller, ['--inspect-owner'], {
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
      let output = Buffer.alloc(0);
      let fault: Refusal | null = null;
      const fail = (code: string) => {
        fault ??= new Refusal(code);
        child.kill();
      };
      const timer = setTimeout(
        () => fail('native_inspection_timeout'),
        120_000,
      );
      timer.unref();
      child.stderr.resume();
      child.once('error', () => fail('native_controller_unavailable'));
      child.stdin.on('error', () => fail('native_host_pipe_failed'));
      child.stdout.on('error', () => fail('native_host_pipe_failed'));
      child.stderr.on('error', () => fail('native_host_pipe_failed'));
      child.stdout.on('data', (chunk: Buffer) => {
        if (fault) return;
        if (output.length + chunk.length > 16 * 1024)
          return fail('native_host_protocol_invalid');
        output = Buffer.concat([output, chunk]);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (fault) return reject(fault);
        let value: unknown;
        try {
          value = JSON.parse(output.toString('utf8'));
        } catch {
          return reject(new Refusal('native_host_inspection_failed'));
        }
        const failed = Failed.safeParse(value);
        if (failed.success) {
          const allowed = [
            'host_recovery_requires_manager',
            'host_profile_identity_changed',
            'host_controller_binding_changed',
            'host_controller_already_owned',
            'host_process_state_requires_review',
            'host_controller_state_unavailable',
          ];
          return reject(
            new Refusal(
              allowed.includes(failed.data.code)
                ? failed.data.code
                : 'native_host_inspection_failed',
            ),
          );
        }
        const result = Quiescent.safeParse(value);
        if (code !== 0 || signal || !result.success)
          return reject(new Refusal('native_host_inspection_failed'));
        const expected = this.installation;
        if (
          result.data.installationId !== id ||
          result.data.manifestSha256 !== manifestSha256 ||
          result.data.sourceRevision !== expected.sourceRevision ||
          result.data.certified !== expected.certified
        )
          return reject(new Refusal('native_host_identity_changed'));
        resolve({
          protocolVersion: 1,
          state: 'stopped',
          inspection: result.data,
        });
      });
      child.stdin.end(wire);
    });
  }
  private stopOwner(owner: Owner): void {
    if (owner.finished) return;
    owner.verifiedRestore = undefined;
    owner.selection?.work.reject(
      owner.fault ?? new Refusal('native_restore_cancelled'),
    );
    if (owner.stopping) return;
    owner.stopping = true;
    // Keep the operation binding until the cancelled child reply drains.
    owner.checkpoint?.cleanup();
    owner.checkpoint?.work.reject(
      owner.fault ?? new Refusal('native_checkpoint_cancelled'),
    );
    owner.restore?.cleanup();
    owner.restore?.work.reject(
      owner.fault ?? new Refusal('native_restore_cancelled'),
    );
    owner.ready.reject(owner.fault ?? new Refusal('native_start_cancelled'));
    if (!owner.child) return;
    owner.child.stdin.end('stop\n');
    owner.stopTimer = setTimeout(() => {
      owner.fault ??= new Refusal('native_shutdown_unconfirmed');
      owner.child?.kill(); // Only a live owned ChildProcess; never a PID from storage.
    }, 170_000);
    owner.stopTimer.unref();
  }
  private finish(owner: Owner): void {
    clearTimeout(owner.startupTimer);
    clearTimeout(owner.stopTimer);
    owner.finished = true;
    if (!owner.readySeen) owner.fault ??= new Refusal('native_start_cancelled');
    owner.checkpoint?.cleanup();
    owner.checkpoint?.work.reject(
      owner.fault ?? new Refusal('native_checkpoint_cancelled'),
    );
    owner.checkpoint = undefined;
    owner.restore?.cleanup();
    owner.restore?.work.reject(
      owner.fault ?? new Refusal('native_restore_cancelled'),
    );
    owner.restore = undefined;
    owner.verifiedRestore = undefined;
    owner.selection?.cleanup();
    if (owner.selection) {
      if (owner.fault || !owner.selection.receipt)
        owner.selection.work.reject(
          owner.fault ?? new Refusal('native_restore_selection_failed'),
        );
      else owner.selection.work.resolve(owner.selection.receipt);
      owner.selection = undefined;
    }
    if (owner.fault) {
      owner.ready.reject(owner.fault);
      owner.closed.reject(owner.fault);
    } else {
      owner.ready.reject(new Refusal('native_start_cancelled'));
      owner.closed.resolve({ protocolVersion: 1, state: 'stopped' });
    }
  }
  private async launch(owner: Owner): Promise<void> {
    try {
      await this.authorizeController();
    } catch {
      owner.fault = new Refusal('native_controller_changed');
      throw owner.fault;
    }
    if (owner.stopping) {
      owner.fault ??= new Refusal('native_start_cancelled');
      throw owner.fault;
    }
    let password: string;
    try {
      password = await this.password();
    } catch {
      owner.fault = new Refusal('native_credentials_unavailable');
      throw owner.fault;
    }
    if (owner.stopping) {
      owner.fault ??= new Refusal('native_start_cancelled');
      throw owner.fault;
    }
    if (
      typeof password !== 'string' ||
      password.length < 24 ||
      Buffer.byteLength(password) > 512 ||
      /[\r\n\0]/.test(password)
    ) {
      owner.fault = new Refusal('native_credentials_unavailable');
      throw owner.fault;
    }
    const { id, candidate, state, manifestSha256, databasePort, apiPort } =
      this.installation;
    const wire =
      JSON.stringify({
        protocolVersion: 1,
        installationId: id,
        candidate,
        state,
        manifestSha256,
        databasePort,
        apiPort,
        ...(owner.mode !== 'server' ? { mode: owner.mode } : {}),
        password,
      }) + '\n';
    if (Buffer.byteLength(wire) > 16 * 1024)
      throw new Refusal('native_installation_invalid');
    const env =
      process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {};
    const child = spawn(this.installation.controller, ['--owner-pipe'], {
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
    owner.child = child;
    child.stderr.resume(); // Never surface child stderr, arguments or credential-bearing config.
    let pending = Buffer.alloc(0);
    const fail = (code: string) => {
      owner.fault ??= new Refusal(code);
      this.stopOwner(owner);
    };
    owner.startupTimer = setTimeout(
      () => fail('native_startup_timeout'),
      300_000,
    );
    owner.startupTimer.unref();
    child.once('error', () => fail('native_controller_unavailable'));
    child.stdin.on('error', () => fail('native_host_pipe_failed'));
    child.stdout.on('error', () => fail('native_host_pipe_failed'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (owner.fault) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 16 * 1024)
        return fail('native_host_protocol_invalid');
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        if (newline + 1 > 8192) return fail('native_host_protocol_invalid');
        let value: unknown;
        try {
          value = JSON.parse(pending.subarray(0, newline).toString('utf8'));
        } catch {
          return fail('native_host_protocol_invalid');
        }
        pending = pending.subarray(newline + 1);
        const running = (
          owner.mode === 'restore-prepare'
            ? RestoreReady
            : owner.mode === 'checkpoint-cleanup'
              ? CleanupReady
              : owner.mode === 'database'
                ? DatabaseReady
                : Running
        ).safeParse(value);
        const checkpoint = CheckpointReply.safeParse(value);
        const restore = NativeRestoreReply.safeParse(value);
        const selection = z
          .union([NativeRestoreSelectionSchema, NativeRestoreFinalizedSchema])
          .safeParse(value);
        if (selection.success) {
          const request = owner.selection;
          if (
            !owner.readySeen ||
            owner.stoppedSeen ||
            owner.mode !== 'restore-prepare' ||
            !request ||
            request.receipt ||
            selection.data.operationId !== request.operationId ||
            selection.data.state !== request.state
          )
            return fail('native_host_protocol_invalid');
          request.receipt = selection.data;
          owner.stopping = true; // Selection is terminal; close input without sending a second command.
          owner.child?.stdin.end();
        } else if (running.success && !owner.readySeen && !owner.stoppedSeen) {
          const expected = this.installation;
          if (
            running.data.manifestSha256 !== expected.manifestSha256 ||
            running.data.sourceRevision !== expected.sourceRevision ||
            running.data.certified !== expected.certified
          )
            return fail('native_host_identity_changed');
          owner.readySeen = true;
          clearTimeout(owner.startupTimer);
          if (!owner.stopping) owner.ready.resolve(running.data);
        } else if (restore.success) {
          const receipt = restore.data,
            request = owner.restore;
          const operation =
            receipt.state === 'restore-prepared'
              ? receipt.binding.operationId
              : receipt.state === 'restore-verified'
                ? receipt.prepared.binding.operationId
                : receipt.operationId;
          const verifying =
            receipt.state === 'restore-verified' ||
            receipt.state === 'restore-verify-failed';
          if (
            !owner.readySeen ||
            owner.stoppedSeen ||
            owner.mode !== 'restore-prepare' ||
            !request ||
            operation !== request.binding.operationId ||
            Boolean(request.prepared) !== verifying ||
            (verifying && owner.verificationIds.has(receipt.verificationId)) ||
            (receipt.state === 'restore-verified' &&
              !isDeepStrictEqual(receipt.prepared, request.prepared)) ||
            (receipt.state === 'restore-prepared' &&
              !isDeepStrictEqual(receipt.binding, request.binding))
          )
            return fail('native_host_protocol_invalid');
          if (verifying) owner.verificationIds.add(receipt.verificationId);
          if (receipt.state === 'restore-verified' && !owner.stopping)
            owner.verifiedRestore = structuredClone(receipt);
          owner.restore = undefined;
          request.cleanup();
          if (
            receipt.state === 'restore-prepared' ||
            receipt.state === 'restore-verified'
          )
            request.work.resolve(receipt);
          else
            request.work.reject(
              new Refusal(
                verifying
                  ? 'native_restore_verification_failed'
                  : 'native_restore_failed',
              ),
            );
        } else if (checkpoint.success) {
          const receipt = checkpoint.data;
          const request = owner.checkpoint;
          if (
            !owner.readySeen ||
            owner.stoppedSeen ||
            !request ||
            receipt.operationId !== request.operationId
          )
            return fail('native_host_protocol_invalid');
          const cleanup =
            receipt.state === 'checkpoint-cleaned' ||
            receipt.state === 'checkpoint-cleanup-failed';
          if (Boolean(request.expected) !== cleanup)
            return fail('native_host_protocol_invalid');
          if (
            receipt.state === 'checkpoint' ||
            receipt.state === 'checkpoint-cleaned'
          ) {
            if (
              receipt.manifestSha256 !== this.installation.manifestSha256 ||
              receipt.sourceRevision !== this.installation.sourceRevision
            )
              return fail('native_host_identity_changed');
            if (
              request.expected &&
              !isDeepStrictEqual(
                { ...receipt, state: 'checkpoint' },
                request.expected,
              )
            )
              return fail('native_host_protocol_invalid');
          }
          owner.checkpoint = undefined;
          request.cleanup();
          if (
            receipt.state === 'checkpoint' ||
            receipt.state === 'checkpoint-cleaned'
          )
            request.work.resolve(receipt);
          else
            request.work.reject(
              new Refusal(
                cleanup
                  ? 'native_checkpoint_cleanup_failed'
                  : 'native_checkpoint_failed',
              ),
            );
        } else if (
          Stopped.safeParse(value).success &&
          owner.stopping &&
          !owner.stoppedSeen
        ) {
          owner.stoppedSeen = true;
        } else if (Failed.safeParse(value).success) {
          return fail('native_host_failed');
        } else return fail('native_host_protocol_invalid');
      }
    });
    child.once('close', (code, signal) => {
      if (
        code !== 0 ||
        signal ||
        pending.length ||
        !owner.stoppedSeen ||
        !owner.stopping
      )
        owner.fault ??= new Refusal('native_shutdown_unconfirmed');
      this.finish(owner);
    });
    child.stdin.write(wire);
  }
}

/** Native lifecycle uses Manager's journal/lock; backup, update and restore remain their existing authorities. */
export class NativeOperations {
  private executing = new Map<string, Promise<void>>();
  constructor(
    readonly store: Store,
    private runtime: NativeRuntime,
    private backup?: (operation: Operation) => Promise<unknown>,
    private restoreWork?: (operation: Operation) => Promise<unknown>,
  ) {}
  control(
    kind: 'start' | 'stop' | 'restart' | 'backup',
    key: string,
  ): Operation {
    if (kind === 'backup' && !this.backup)
      throw new Refusal('native_action_unavailable');
    if (!['start', 'stop', 'restart', 'backup'].includes(kind))
      throw new Refusal('invalid_control_operation');
    const { operation, created } = this.store.start(kind, key, {
      ...this.runtime.identity,
    });
    if (created) this.launch(operation);
    return operation;
  }
  resume(id: string): Operation {
    const operation = this.store.history().find((value) => value.id === id);
    if (
      !operation ||
      this.executing.has(id) ||
      !['failed', 'interrupted'].includes(operation.state) ||
      (!['start', 'stop', 'restart'].includes(operation.kind) &&
        !(operation.kind === 'backup' && this.backup) &&
        !(operation.kind === 'restore' && this.restoreWork)) ||
      (operation.kind === 'restore' &&
        !checkpointOperation.safeParse(operation.input.reviewId).success) ||
      !isDeepStrictEqual(
        operation.input,
        operation.kind === 'restore'
          ? { reviewId: operation.input.reviewId, ...this.runtime.identity }
          : this.runtime.identity,
      )
    )
      throw new Refusal('operation_not_recoverable');
    operation.state = 'running';
    operation.error = null;
    this.store.save(operation);
    this.launch(operation);
    return operation;
  }
  restore(reviewId: string, key: string): Operation {
    if (!this.restoreWork) throw new Refusal('native_action_unavailable');
    if (
      !checkpointOperation.safeParse(reviewId).success ||
      !checkpointOperation.safeParse(key).success
    )
      throw new Refusal('native_restore_request_invalid');
    const { operation, created } = this.store.start('restore', key, {
      reviewId,
      ...this.runtime.identity,
    });
    if (created) this.launch(operation);
    return operation;
  }
  async wait(id: string): Promise<Operation> {
    try {
      await this.executing.get(id);
      const operation = this.store.history().find((value) => value.id === id);
      if (!operation) throw new Refusal('operation_not_found');
      return operation;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal('operation_journal_unavailable');
    }
  }
  private launch(operation: Operation): void {
    const work = this.run(operation)
      .then(() => {
        operation.state = 'complete';
        this.store.save(operation);
      })
      .catch((error: unknown) => {
        operation.state = 'failed';
        operation.error =
          error instanceof Refusal ? error.code : 'operation_failed';
        this.store.save(operation);
      })
      .finally(() => this.executing.delete(operation.id));
    this.executing.set(operation.id, work);
    // A failed journal write retains its database lock; detached API calls must not crash Manager.
    void work.catch(() => {});
  }
  private async step(
    operation: Operation,
    name: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    operation.step = name;
    this.store.save(operation);
    operation.receipts[name] = await work();
    if (!operation.completed.includes(name)) operation.completed.push(name);
    this.store.save(operation);
  }
  private async run(operation: Operation): Promise<void> {
    if (operation.kind === 'restore') {
      if (!this.restoreWork) throw new Refusal('native_action_unavailable');
      await this.restoreWork(operation);
      return;
    }
    if (operation.kind === 'backup') {
      if (!this.backup) throw new Refusal('native_action_unavailable');
      await this.backup(operation);
      return;
    }
    if (
      operation.kind === 'restart' &&
      !operation.completed.includes('stop-native-host')
    )
      await this.step(operation, 'stop-native-host', () => this.runtime.stop());
    // A historical start/stop receipt cannot establish current owned process state after recovery.
    if (operation.kind === 'stop')
      await this.step(operation, 'stop-native-host', () => this.runtime.stop());
    else
      await this.step(operation, 'start-native-host', () =>
        this.runtime.start(),
      );
  }
}
