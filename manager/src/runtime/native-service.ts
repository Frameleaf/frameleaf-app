import {
  createHash,
  createPrivateKey,
  randomUUID,
  X509Certificate,
} from 'node:crypto';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, join } from 'node:path';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { digest, Refusal, releaseTag } from '../contracts.js';
import { Store } from '../store.js';
import { command } from '../docker.js';
import { Backups } from '../backups.js';
import { runNativeDatabaseBackup } from './native-backup-operation.js';
import { runNativeRestore } from './native-restore-operation.js';
import {
  completeNativeMediaCutover,
  nativeActiveMediaIdentity,
  nativeMediaMoveAdmission,
} from './native-media-cutover.js';
import {
  prepareNativeRestoreReview,
  nativeRestoreReviewStatus,
} from './native-restore-review.js';
import { nativeListener } from './native-listener.js';
import {
  NativeHost,
  NativeOperations,
  SecureInstallationIdSchema,
  type NativeRuntime,
} from './native.js';

import { approveNativeUpdate } from './native-update-approval.js';
import {
  admitNativeInstallation,
  NativeTlsRotation,
  NativeTransition,
} from './native-installation.js';
const path = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[^\r\n\0]+$/)
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const Installation = z
  .object({
    runtime: z.literal('native'),
    id: z.string().regex(/^[a-f0-9]{12}$/),
    secureInstallationId: SecureInstallationIdSchema,
    controller: path,
    candidate: path,
    state: path,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    certified: z.boolean(),
    databasePort: z.number().int().min(1).max(65535),
    apiPort: z.number().int().min(1).max(65535),
  })
  .strict()
  .refine((value) => value.databasePort !== value.apiPort);
const BackupEngine = z
  .object({
    // Desktop 0.1.1 joins the manifest role `backup/restic.exe` to a Windows path.
    executable: z.preprocess(
      (value) => process.platform === 'win32' && typeof value === 'string'
        ? value.replace(/\\backup\/restic\.exe$/, '\\backup\\restic.exe')
        : value,
      path,
    ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const Configuration = z
  .object({
    protocolVersion: z.literal(2),
    installation: Installation,
    controllerSha256: z.string().regex(/^[a-f0-9]{64}$/),
    backupEngine: BackupEngine,
    name: z.string().trim().min(1).max(120),
    release: releaseTag,
  })
  .strict();
const Descriptor = Configuration.extend({
  tlsCertificatePemSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const Binding = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    descriptor: Descriptor,
  })
  .strict();
const Bootstrap = Configuration.extend({
  tls: z
    .object({
      certificatePem: z.string().min(1).max(8192),
      privateKeyPem: z.string().min(1).max(8192),
    })
    .strict(),
  backupKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z
    .string()
    .min(24)
    .max(256)
    .regex(/^[^\r\n\0]+$/),
  installationTransition: NativeTransition.optional(),
  // A new TLS certificate, handed over by the key of the one this store last accepted.
  tlsRotation: NativeTlsRotation.optional(),
  // Only the installed qualification supervisor may opt in through bootstrap.
  mediaMoveQualification: z.strictObject({
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
})
  .strict()
  .refine((value) => value.backupKey !== value.password)
  .refine((value) => !value.mediaMoveQualification || (
    process.platform === 'win32' &&
    value.mediaMoveQualification.manifestSha256 === value.installation.manifestSha256 &&
    basename(value.installation.state) === 'state' &&
    /^Frameleaf Media Move Qualification [a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      .test(basename(dirname(value.installation.state)))
  ));
export type NativeBootstrap = z.infer<typeof Bootstrap>;

/** One private inherited pipe from the desktop supervisor; never HTTP, argv, env or a state file. */
export async function readNativeBootstrap(
  input: Readable,
  timeout = 5000,
): Promise<NativeBootstrap> {
  let raw = Buffer.alloc(0);
  const timer = setTimeout(
    () => input.destroy(new Refusal('native_bootstrap_unavailable')),
    timeout,
  );
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (raw.length + bytes.length > 16 * 1024)
        throw new Refusal('native_bootstrap_invalid');
      const next = Buffer.concat([raw, bytes]);
      raw.fill(0);
      raw = next;
    }
    if (
      !raw.length ||
      raw[raw.length - 1] !== 10 ||
      raw.subarray(0, -1).includes(10)
    )
      throw new Refusal('native_bootstrap_invalid');
    const value = Bootstrap.safeParse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
    );
    if (!value.success) throw new Refusal('native_bootstrap_invalid');
    await verifyExecutable(
      value.data.installation.controller,
      value.data.controllerSha256,
      'native_controller_changed',
    );
    await verifyExecutable(
      value.data.backupEngine.executable,
      value.data.backupEngine.sha256,
      'native_backup_engine_changed',
    );
    return value.data;
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('native_bootstrap_invalid');
  } finally {
    clearTimeout(timer);
    raw.fill(0);
    input.destroy();
  }
}
const execute = promisify(execFile);
/** Root-owned, non-writable ancestors prevent pathname replacement through launch; no development bypass. */
export async function protectNativeController(path: string): Promise<void> {
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Refusal('native_controller_protection_unavailable');
  const ancestors: string[] = [];
  for (let current = path; ; current = dirname(current)) {
    ancestors.unshift(current);
    if (dirname(current) === current) break;
  }
  for (const current of ancestors) {
    const metadata = await lstat(current);
    if (
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0 ||
      (current === path ? !metadata.isFile() : !metadata.isDirectory())
    )
      throw new Refusal('native_controller_unprotected');
    if (
      process.getuid?.() !== 0 &&
      (await access(current, constants.W_OK).then(
        () => true,
        () => false,
      ))
    )
      throw new Refusal('native_controller_unprotected');
    if (process.platform === 'darwin') {
      // Reject all extended ACLs, including grants to principals other than this process's user.
      const { stdout, stderr } = await execute('/bin/ls', ['-lde', current], {
        env: { LC_ALL: 'C' },
        timeout: 3000,
        maxBuffer: 16 * 1024,
      });
      if (!nativeControllerAclSafe(stdout, stderr))
        throw new Refusal('native_controller_unprotected');
    }
  }
}
export function nativeControllerAclSafe(
  stdout: string,
  stderr: string,
): boolean {
  return (
    !stderr &&
    stdout.trimEnd().split('\n').length === 1 &&
    /^[d-][rwxstST-]{9}[@ ]/.test(stdout)
  );
}
/** Accept the OS directory only from a complete native controller protection receipt. */
export function nativeWindowsSystemRoot(value: unknown): string {
  const receipt = z.object({
    protocolVersion: z.literal(1),
    state: z.literal('protected'),
    systemRoot: path,
  }).strict().safeParse(value);
  if (!receipt.success) throw new Refusal('native_controller_unprotected');
  return receipt.data.systemRoot;
}
/** Use the bootstrap-pinned Desktop controller to verify the two supported Windows program paths. */
function installedProgramProtection(bootstrap: NativeBootstrap) {
  if (process.platform !== 'win32') return protectNativeController;
  const { controller, candidate, manifestSha256 } = bootstrap.installation;
  return async (executable: string): Promise<void> => {
    const program =
      executable === controller
        ? 'controller'
        : executable === join(candidate, 'payload', 'backup', 'restic.exe')
          ? 'restic'
          : null;
    if (!program) throw new Refusal('native_controller_unprotected');
    // Desktop verifies the installed controller before passing this private bootstrap.
    await verifyExecutable(controller, bootstrap.controllerSha256, 'native_controller_changed');
    try {
      const { stdout, stderr } = await execute(
        controller,
        ['--verify-installed-program', manifestSha256, bootstrap.controllerSha256, program],
        {
          env: process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {},
          windowsHide: true,
          timeout: 3000,
          maxBuffer: 1024,
        },
      );
      if (stderr) throw new Refusal('native_controller_unprotected');
      // Desktop 0.1.1 clears SystemRoot; Windows OpenSSL needs the OS directory for entropy.
      process.env.SystemRoot = nativeWindowsSystemRoot(JSON.parse(stdout));
    } catch {
      throw new Refusal('native_controller_unprotected');
    }
  };
}

/** Verify executable protection and identity before the native Manager can become ready. */
export async function createNativeService(
  store: Store,
  input: Readable,
  origin: string,
  backupRepository = join(store.directory, 'backups', 'frameleaf-database'),
): Promise<NativeService> {
  const bootstrap = await readNativeBootstrap(input);
  const protect = installedProgramProtection(bootstrap);
  await protect(bootstrap.installation.controller);
  await verifyNativeBackupEngine(bootstrap.backupEngine, protect);
  validateNativeTls(bootstrap.tls, origin);
  validateNativePorts(bootstrap.installation, origin);
  if (!path.safeParse(backupRepository).success)
    throw new Refusal('native_backup_destination_invalid');
  const backups = new Backups(
    backupRepository,
    async () => bootstrap.backupKey,
    nativeBackupCommand(bootstrap.backupEngine, command, protect),
  );
  return new NativeService(store, bootstrap, undefined, backups);
}
/**
 * The database and photo ports are the supervisor's configuration. The schema already requires
 * two different ports; neither may be the one Manager itself serves on.
 */
export function validateNativePorts(
  installation: Pick<NativeBootstrap['installation'], 'databasePort' | 'apiPort'>,
  origin: string,
): void {
  const manager = nativeListener(origin).port;
  if ([installation.databasePort, installation.apiPort].includes(manager))
    throw new Refusal('native_ports_invalid');
}
export function validateNativeTls(
  tls: NativeBootstrap['tls'],
  origin: string,
): void {
  try {
    const address = new URL(origin);
    if (address.protocol !== 'https:' || address.origin !== origin)
      throw Error();
    if (
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(
        tls.certificatePem,
      ) ||
      !/^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+-----END PRIVATE KEY-----\s*$/.test(
        tls.privateKeyPem,
      )
    )
      throw Error();
    const certificate = new X509Certificate(tls.certificatePem);
    const key = createPrivateKey(tls.privateKeyPem);
    const hostname = address.hostname.replace(/^\[|\]$/g, '');
    const host = isIP(hostname)
      ? certificate.checkIP(hostname)
      : certificate.checkHost(hostname, { subject: 'never', wildcards: false });
    if (
      !host ||
      !certificate.checkPrivateKey(key) ||
      !certificate.verify(certificate.publicKey) ||
      certificate.validFromDate.getTime() > Date.now() ||
      certificate.validToDate.getTime() <= Date.now()
    )
      throw Error();
  } catch {
    throw new Refusal('native_tls_invalid');
  }
}
/** Recheck the installed controller before using it to dispatch a native operation. */
async function verifyInstalledController(
  value: NativeBootstrap,
): Promise<void> {
  await installedProgramProtection(value)(value.installation.controller);
  await verifyExecutable(
    value.installation.controller,
    value.controllerSha256,
    'native_controller_changed',
  );
}
/** Hash the opened regular file and reject changes to its identity during verification. */
async function verifyExecutable(
  path: string,
  sha256: string,
  code: string,
): Promise<void> {
  // Windows exposes a different spelling for the same device path. The
  // controller checks the actual installed path and rejects reparse points.
  if (process.platform === 'win32' ? !(await lstat(path)).isFile() : (await realpath(path)) !== path)
    throw new Refusal(code);
  const file = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW ?? 0) |
      (constants.O_NONBLOCK ?? 0),
  );
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > 512 * 1024 * 1024 ||
      (process.platform !== 'win32' &&
        ((metadata.mode & 0o022) !== 0 || (metadata.mode & 0o111) === 0))
    )
      throw new Refusal(code);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > metadata.size) throw new Refusal(code);
      hash.update(chunk);
    }
    const after = await file.stat();
    if (
      size !== metadata.size ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs
    )
      throw new Refusal(code);
    if (hash.digest('hex') !== sha256) throw new Refusal(code);
  } finally {
    await file.close();
  }
}
/** Require both installation protection and the pinned digest before using the backup engine. */
async function verifyNativeBackupEngine(
  engine: NativeBootstrap['backupEngine'],
  protect: typeof protectNativeController,
): Promise<void> {
  try {
    await protect(engine.executable);
    await verifyExecutable(
      engine.executable,
      engine.sha256,
      'native_backup_engine_changed',
    );
  } catch {
    throw new Refusal('native_backup_engine_changed');
  }
}
/** Bind each backup invocation to the protected, digest-pinned restic executable. */
export function nativeBackupCommand(
  engine: NativeBootstrap['backupEngine'],
  execute: typeof command = command,
  protect: typeof protectNativeController = protectNativeController,
): typeof command {
  const binding = Object.freeze(BackupEngine.parse(engine));
  return async (binary, args, options = {}) => {
    if (binary !== 'restic' || options.executable !== undefined)
      throw new Refusal('native_backup_command_invalid');
    await verifyNativeBackupEngine(binding, protect);
    return execute('restic', args, {
      ...options,
      executable: binding.executable,
    });
  };
}

/** The installed supervisor owns bootstrap authority; Manager owns the existing operation journal. */
export class NativeService {
  private readonly lifecycle: NativeOperations;
  private readonly recoveryContext: Parameters<
    typeof prepareNativeRestoreReview
  >[2];
  private readonly updateApproval: (
    input: unknown,
  ) => ReturnType<typeof approveNativeUpdate>;
  readonly mediaMove?: ReturnType<typeof nativeMediaMoveAdmission>;
  private reviewPending = false;
  private activeReview?: string;
  readonly runtime: NativeRuntime;
  readonly backupCommand: typeof command;
  readonly backupPassword: () => Promise<string>;
  private readonly tls: NativeBootstrap['tls'];
  private readonly publicInstallation: {
    id: string;
    name: string;
    release: string;
    port: number;
    runtime: 'native';
  };
  constructor(
    readonly store: Store,
    bootstrap: NativeBootstrap,
    runtime?: NativeRuntime,
    readonly backups?: Backups,
  ) {
    bootstrap = Bootstrap.parse(bootstrap);
    Object.freeze(bootstrap.installation);
    Object.freeze(bootstrap.backupEngine);
    this.backupCommand = nativeBackupCommand(bootstrap.backupEngine, command, installedProgramProtection(bootstrap));
    if (store.get('installation')) throw new Refusal('manager_runtime_changed');
    const {
      password,
      backupKey,
      tls,
      installationTransition,
      tlsRotation,
      mediaMoveQualification,
      ...configuration
    } = bootstrap;
    this.backupPassword = async () => backupKey;
    const descriptor = {
      ...configuration,
      tlsCertificatePemSha256: createHash('sha256')
        .update(tls.certificatePem)
        .digest('hex'),
    };
    this.tls = Object.freeze(tls);
    this.manifestSha256 = bootstrap.installation.manifestSha256;
    const fingerprint = digest(descriptor);
    const supplied =
      runtime ??
      new NativeHost(
        bootstrap.installation,
        async () => password,
        () => verifyInstalledController(bootstrap),
        () => nativeActiveMediaIdentity(store, bootstrap.installation),
      );
    if (supplied.identity.installationId !== bootstrap.installation.id)
      throw new Refusal('native_installation_changed');
    // Only the inherited supervisor bootstrap reaches this; it holds source process exclusion.
    admitNativeInstallation(
      store,
      descriptor,
      (value) => {
        const parsed = Binding.safeParse(value);
        return parsed.success ? parsed.data : null;
      },
      { transition: installationTransition, rotation: tlsRotation },
    );
    if (
      store.get<{ fingerprint: string }>('native-installation')?.fingerprint !==
      fingerprint
    )
      throw new Refusal('native_installation_changed');
    this.runtime = supplied;
    store.createOnce('native-library-id', bootstrap.installation.id);
    const libraryId = store.get<string>('native-library-id');
    if (typeof libraryId !== 'string' || !/^[a-f0-9]{12}$/.test(libraryId))
      throw new Refusal('native_library_identity_invalid');
    const context = {
      installation: bootstrap.installation,
      libraryId,
      name: bootstrap.name,
      release: bootstrap.release,
    };
    this.updateApproval = (input) =>
      approveNativeUpdate(
        store,
        this.runtime,
        { ...context, managerFingerprint: fingerprint },
        backupKey,
        input,
      );
    this.recoveryContext = {
      installation: context.installation,
      libraryId,
      release: context.release,
    };
    // Recovery only: until Windows qualification there is no Manager or Desktop
    // entry point to admit a new move.
    const mediaOwner =
      process.platform === 'win32' && !runtime && supplied instanceof NativeHost
        ? supplied.mediaMoveAuthority()
        : undefined;
    const qualifyMediaMove = Boolean(mediaOwner && mediaMoveQualification);
    this.lifecycle = new NativeOperations(
      store,
      this.runtime,
      backups
        ? (operation) =>
            runNativeDatabaseBackup(
              store,
              this.runtime,
              backups,
              { ...context, retainMediaQualificationSafety: qualifyMediaMove },
              operation,
            )
        : undefined,
      backups
        ? (operation) =>
            runNativeRestore(store, this.runtime, backups, context, operation)
        : undefined,
      mediaOwner
        ? (operation) =>
            completeNativeMediaCutover(
              store,
              mediaOwner,
              context.installation,
              operation,
              () => this.runtime.start(),
            )
        : undefined,
    );
    if (mediaOwner && mediaMoveQualification) {
      this.mediaMove = nativeMediaMoveAdmission(
        store, mediaOwner, context.installation, libraryId,
        (key, input) => this.lifecycle.admitMediaMove(key, input),
      );
    }
    this.publicInstallation = Object.freeze({
      id: bootstrap.installation.id,
      name: bootstrap.name,
      release: bootstrap.release,
      port: bootstrap.installation.apiPort,
      runtime: 'native',
    });
  }
  private readonly manifestSha256: string;
  ready(origin: string) {
    nativeListener(origin);
    return {
      protocolVersion: 2,
      state: 'ready',
      installationId: this.publicInstallation.id,
      manifestSha256: this.manifestSha256,
      origin,
    };
  }
  httpsOptions() {
    return { cert: this.tls.certificatePem, key: this.tls.privateKeyPem };
  }
  installation() {
    return this.publicInstallation;
  }
  async approveUpdate(input: unknown, installationId: string) {
    if (installationId !== this.publicInstallation.id)
      throw new Refusal('installation_changed');
    return this.updateApproval(input);
  }
  async listRestoreBackups(installationId: string) {
    if (installationId !== this.publicInstallation.id)
      throw new Refusal('installation_changed');
    if (!this.backups) throw new Refusal('native_backup_unavailable');
    const result = z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            time: z.string().datetime({ offset: true }),
          })
          .strict(),
      )
      .safeParse(
        (await this.backups.list()).map(({ id, time }) => ({ id, time })),
      );
    if (!result.success) throw new Refusal('native_backup_index_invalid');
    return result.data;
  }
  async reviewRestore(
    snapshot: string,
    installationId: string,
    key: string = randomUUID(),
  ) {
    if (installationId !== this.publicInstallation.id)
      throw new Refusal('installation_changed');
    if (!this.backups) throw new Refusal('native_backup_unavailable');
    const backups = this.backups;
    if (
      !z.string().uuid().safeParse(key).success ||
      key !== key.toLowerCase() ||
      key === '00000000-0000-0000-0000-000000000000'
    )
      throw new Refusal('native_restore_request_invalid');
    const acceptance = {
      id: key,
      snapshot,
      installationId,
      state: 'preparing' as const,
    };
    if (this.store.get(`native-restore-review:${key}`) !== null) {
      const prior = this.restoreReview(key, installationId);
      if (prior.snapshot !== snapshot)
        throw new Refusal('native_restore_review_changed');
      return acceptance;
    }
    if (this.reviewPending) throw new Refusal('native_restore_review_busy');
    this.reviewPending = true;
    return new Promise<{
      id: string;
      snapshot: string;
      installationId: string;
      state: 'preparing';
    }>((resolve, reject) => {
      const work = prepareNativeRestoreReview(
        this.store,
        backups,
        this.recoveryContext,
        snapshot,
        (id) => {
          this.activeReview = id;
          resolve(acceptance);
        },
        key,
      );
      // The durable review record owns completion after the HTTP acknowledgement.
      void work.catch(reject).finally(() => {
        this.reviewPending = false;
        this.activeReview = undefined;
      });
    });
  }
  restoreReview(id: string, installationId: string) {
    if (installationId !== this.publicInstallation.id)
      throw new Refusal('installation_changed');
    const status = nativeRestoreReviewStatus(
      this.store,
      this.recoveryContext,
      id,
    );
    return status.state === 'preparing' && this.activeReview !== id
      ? { ...status, state: 'interrupted' as const }
      : status;
  }
  control(
    action: 'start' | 'stop' | 'restart' | 'backup',
    key: string,
    installationId?: string,
  ) {
    if (installationId && installationId !== this.publicInstallation.id)
      throw new Refusal('installation_changed');
    return this.lifecycle.control(action, key);
  }
  restore(reviewId: string, key: string, installationId: string) {
    if (installationId !== this.publicInstallation.id)
      throw new Refusal('installation_changed');
    if (!this.backups) throw new Refusal('native_backup_unavailable');
    const uuid =
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (
      typeof reviewId !== 'string' ||
      typeof key !== 'string' ||
      !uuid.test(reviewId) ||
      !uuid.test(key)
    )
      throw new Refusal('native_restore_request_invalid');
    const prior = this.store.request('restore', key, {
      reviewId,
      ...this.runtime.identity,
    });
    if (prior) return prior;
    const review = this.restoreReview(reviewId, installationId);
    if (review.state === 'expired')
      throw new Refusal('native_restore_review_expired');
    if (review.state !== 'prepared')
      throw new Refusal('native_restore_review_not_ready');
    if (review.requiresRuntimeChange)
      throw new Refusal('native_restore_runtime_change_required');
    return this.lifecycle.restore(reviewId, key);
  }
  resume(id: string) {
    return this.lifecycle.resume(id);
  }
  wait(id: string) {
    return this.lifecycle.wait(id);
  }
}
