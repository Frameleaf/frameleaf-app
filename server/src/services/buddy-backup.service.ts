import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { CronTime } from 'cron';
import { sql } from 'kysely';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, readFile, readdir, realpath, rm, stat, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type {
  BuddyControlDto,
  BuddyKitDto,
  BuddyPreflightRequestDto,
  BuddySettingsDto,
  BuddyStatusDto,
} from 'src/dtos/buddy-backup.dto.js';
import type { SystemNotificationTemplate } from 'src/utils/notification-locale.js';
import type z from 'zod';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  DatabaseLock,
  ImmichWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  NotificationLevel,
  NotificationType,
} from 'src/enum.js';
import { BuddyBackupRepository, type BuddyState } from 'src/repositories/buddy-backup.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { type MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { BuddyBackupCaptureService } from 'src/services/buddy-backup-capture.service.js';
import { BuddyBackupPeerService } from 'src/services/buddy-backup-peer.service.js';
import { BuddyBackupClient, BuddyExecutionError, BuddyPeerUnavailable } from 'src/utils/buddy-backup-client.js';
import {
  type BuddyKeyring,
  buddyObjectId,
  createBuddyKeyring,
  decryptBuddyBlock,
  encryptBuddyBlock,
  parseBuddyKeyring,
} from 'src/utils/buddy-backup-crypto.js';
import { assertBuddyCommitReceipt } from 'src/utils/buddy-backup-protocol.js';
import { BuddyBackupReader } from 'src/utils/buddy-backup-reader.js';
import { buddyInside } from 'src/utils/buddy-backup-recovery.js';
import {
  type BuddyReceipt,
  type BuddySignedSnapshot,
  BuddyVault,
  buddySnapshotBytes,
  createBuddyDirectory,
  writeBuddyFile,
} from 'src/utils/buddy-backup-vault.js';
import {
  advanceExecutionProgress,
  assertExecutionActive,
  executionDelay,
  executionSignal,
} from 'src/utils/execution-signal.js';
import {
  type BuddyAcceptRequest,
  BuddyAction,
  BuddyGrantResponse,
  type BuddyInviteRequest,
  BuddyInviteResponse,
  BuddyPairing,
  BuddyStatusResponse,
} from 'src/utils/frameleaf-buddy.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';
import { OperationDeadlineError, settleOperationStop, withOperationExecution } from 'src/utils/operation-execution.js';

const KINDS = [MediaOperationKind.BuddyBackup, MediaOperationKind.BuddyRestore];
const LEASE_MS = 300_000;
class BuddyStopped extends Error {}

@Injectable()
export class BuddyBackupService {
  private active?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private housekeepingAt = 0;

  constructor(
    readonly repository: BuddyBackupRepository,
    readonly peer: BuddyBackupPeerService,
    private capture: BuddyBackupCaptureService,
    private operations: MediaOperationRepository,
    private rates: RateLimitRepository,
    private events: EventRepository,
    private logger: LoggingRepository,
  ) {}

  async status(): Promise<BuddyStatusDto> {
    const state = await this.repository.state();
    const identity = await this.peer.identity();
    const hosted = state.pairing?.vaults.find((vault) => vault.destinationInstanceId === identity.instanceId);
    const usage =
      hosted && state.settings
        ? await this.repository.locked(hosted.vaultId, () =>
            new BuddyVault(state.settings!.directory, hosted.vaultId).usage(),
          )
        : { committedBytes: 0, reservedBytes: 0 };
    const ring = await this.keyring().catch(() => null);
    const source = state.pairing?.vaults.find((vault) => vault.sourceInstanceId === identity.instanceId);
    const peerUsage = source?.vaultId === state.peerUsage?.vaultId ? state.peerUsage : undefined;
    return {
      enabled: process.env.FRAMELEAF_BUDDY_BACKUP === 'true',
      configured: !!state.settings,
      instanceId: identity.instanceId,
      settings: state.settings,
      pairing: state.pairing,
      recoveryVerified: state.recoveryVerified,
      keyFingerprint: ring ? createHash('sha256').update(JSON.stringify(ring)).digest('hex').slice(0, 16) : null,
      lastCompleteAt: state.lastCompleteAt,
      lastVerifiedAt: state.lastVerifiedAt,
      run: state.run,
      connection: state.transfer?.connection ?? null,
      transferMbps: state.transfer && Date.parse(state.transfer.at) > Date.now() - 30_000 ? state.transfer.mbps : 0,
      pendingObjects: state.run ? Math.max(0, state.run.objects - state.run.uploadedObjects) : 0,
      availableBytes:
        source && peerUsage
          ? Math.max(0, source.quotaBytes - peerUsage.committedBytes - peerUsage.reservedBytes)
          : null,
      capacityUpdatedAt: peerUsage?.at ?? null,
      hosting: { ...usage, quotaBytes: state.settings?.quotaBytes ?? 0 },
    };
  }

  async preflight(dto: BuddyPreflightRequestDto) {
    const libraries = await this.repository.db.selectFrom('library').select('importPaths').execute();
    const roots = [
      ...new Set([StorageCore.getMediaLocation(), ...libraries.flatMap((library) => library.importPaths)]),
    ];
    const identity = await realpath(dirname(this.repository.root()));
    const configuration = [
      ...new Set(
        [
          ...dto.configurationFiles,
          ...(process.env.FRAMELEAF_CONFIG_FILE ? [process.env.FRAMELEAF_CONFIG_FILE] : []),
        ].map((path) => resolve(path)),
      ),
    ];
    const configurationFiles = [];
    for (const path of configuration) {
      let available = false;
      try {
        const canonical = await realpath(path);
        await access(canonical, constants.R_OK);
        available = !buddyInside(identity, canonical) && (await stat(canonical)).isFile();
      } catch {
        /* Coverage reports missing or unreadable declared files before setup. */
      }
      configurationFiles.push({ path, available });
    }
    const mounts = [];
    for (const path of roots) {
      let available = false;
      try {
        await access(path, constants.R_OK);
        available = (await stat(path)).isDirectory();
      } catch {
        /* unavailable mount */
      }
      mounts.push({ path, available });
    }
    const { rows } = await sql<{ items: string; bytes: string; unknown: string; database: string }>`
      SELECT count(a.id) AS items, coalesce(sum(e."fileSizeInByte"), 0) AS bytes,
        count(a.id) FILTER (WHERE e."fileSizeInByte" IS NULL) AS unknown,
        pg_database_size(current_database()) AS database
      FROM asset a LEFT JOIN asset_exif e ON e."assetId" = a.id`.execute(this.repository.db);
    const available = async (path: string) => {
      const fs = await statfs(path);
      return Math.max(0, fs.bavail * fs.bsize - Math.max(10 * 1024 ** 3, fs.blocks * fs.bsize * 0.1));
    };
    let hostingAvailableBytes: number | null = null;
    if (dto.directory && isAbsolute(dto.directory)) {
      let parent = resolve(dto.directory);
      while (!(await stat(parent).catch(() => null)) && dirname(parent) !== parent) parent = dirname(parent);
      hostingAvailableBytes = await available(parent).catch(() => null);
    }
    return {
      timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      items: Number(rows[0].items),
      originalBytes: Number(rows[0].bytes),
      unknownSizes: Number(rows[0].unknown),
      databaseBytes: Number(rows[0].database),
      stagingAvailableBytes: await available(identity),
      hostingAvailableBytes,
      mounts,
      configurationFiles,
    };
  }

  async setup(dto: BuddySettingsDto) {
    new CronTime(dto.schedule, dto.timezone);
    new Intl.DateTimeFormat('en', { timeZone: dto.timezone }).format();
    if (!isAbsolute(dto.directory) || dto.configurationFiles.some((path) => !isAbsolute(path)))
      throw new BadRequestException('Use absolute hosting and deployment configuration paths.');
    const proposed = resolve(dto.directory);
    const libraries = await this.repository.db.selectFrom('library').select('importPaths').execute();
    const roots = [StorageCore.getMediaLocation(), ...libraries.flatMap((library) => library.importPaths)];
    const overlap = (a: string, b: string) => {
      const path = relative(a, b);
      return !path || (path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
    };
    await createBuddyDirectory(proposed);
    const directory = await realpath(proposed);
    for (const root of roots) {
      const canonical = await realpath(root);
      if (overlap(canonical, directory) || overlap(directory, canonical))
        throw new BadRequestException(
          'Choose a dedicated hosting directory outside the photo library and all external libraries.',
        );
    }
    dto.configurationFiles = [
      ...new Set(
        [
          ...dto.configurationFiles,
          ...(process.env.FRAMELEAF_CONFIG_FILE ? [process.env.FRAMELEAF_CONFIG_FILE] : []),
        ].map((path) => resolve(path)),
      ),
    ];
    if (dto.configurationFiles.length > 32)
      throw new BadRequestException(
        'Declare at most 32 configuration files, including the Frameleaf configuration file.',
      );
    const identityRoot = await realpath(dirname(this.repository.root()));
    for (const path of dto.configurationFiles) {
      const canonical = await realpath(path);
      if (buddyInside(identityRoot, canonical) || !(await stat(canonical)).isFile())
        throw new BadRequestException('Configuration must be a regular file outside the server identity directory.');
      await access(canonical, constants.R_OK);
    }
    const marker = join(directory, 'frameleaf-buddy-vault.json');
    const identity = await this.peer.identity();
    await this.repository.locked('peer-access', async (trx) => {
      const current = await this.repository.state();
      if (current.settings && current.settings.directory !== directory)
        throw new ConflictException('Export or move the hosted vault before choosing another hosting directory.');
      const entries = await readdir(directory);
      if (entries.length > 0 && !entries.includes('frameleaf-buddy-vault.json'))
        throw new BadRequestException('Choose an empty dedicated hosting directory.');
      if (entries.includes('frameleaf-buddy-vault.json')) {
        const existing = JSON.parse(await readFile(marker, 'utf8'));
        if (existing.version !== 1 || existing.instanceId !== identity.instanceId)
          throw new ConflictException('This vault belongs to another server. Use recovery onboarding.');
      } else await writeBuddyFile(marker, JSON.stringify({ version: 1, instanceId: identity.instanceId }), true);
      await this.repository.update(
        (state) => ({ ...state, settings: { ...dto, directory }, nextScheduledAt: null }),
        trx,
      );
    });
    return this.status();
  }

  async keyring(vaultId?: string): Promise<BuddyKeyring> {
    if (vaultId) {
      const state = await this.repository.state();
      if (!state.pairing?.vaults.some((vault) => vault.vaultId === vaultId))
        throw new Error('Buddy vault binding changed');
      return parseBuddyKeyring(
        JSON.parse(await readFile(join(this.repository.root(), `${vaultId}.keys.json`), 'utf8')),
        vaultId,
      );
    }
    const state = await this.repository.state();
    const identity = await this.peer.identity();
    const direction = state.pairing?.vaults.find((vault) => vault.sourceInstanceId === identity.instanceId);
    if (!direction) throw new Error('Choose and confirm a buddy first.');
    return parseBuddyKeyring(
      JSON.parse(await readFile(join(this.repository.root(), `${direction.vaultId}.keys.json`), 'utf8')),
      direction.vaultId,
    );
  }

  async generateKit() {
    const pairing = await this.peer.pairing();
    const identity = await this.peer.identity();
    return this.repository.locked('keyring', async (trx) => {
      const direction = pairing?.vaults.find((vault) => vault.sourceInstanceId === identity.instanceId);
      if (!direction) throw new BadRequestException('Choose and confirm a buddy first.');
      const ring = createBuddyKeyring(direction.vaultId);
      try {
        await writeBuddyFile(join(this.repository.root(), `${ring.vaultId}.keys.json`), JSON.stringify(ring), true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ConflictException('This vault already has a recovery kit. Import that kit to recover it.');
        throw error;
      }
      await this.repository.update((state) => ({ ...state, recoveryVerified: false }), trx);
      return ring;
    });
  }

  async verifyKit(dto: BuddyKitDto) {
    const ring = await this.keyring();
    const incoming = parseBuddyKeyring(dto, ring.vaultId);
    if (
      ring.current !== incoming.current ||
      Object.entries(ring.keys).some(([version, key]) => incoming.keys[version] !== key)
    )
      throw new BadRequestException('The recovery kit does not match this vault.');
    await this.repository.update((state) => ({ ...state, recoveryVerified: true }));
    return this.status();
  }

  async importKit(dto: BuddyKitDto) {
    const pairing = await this.peer.pairing();
    const identity = await this.peer.identity();
    const vault = pairing?.vaults.find((vault) => vault.sourceInstanceId === identity.instanceId);
    if (!vault) throw new BadRequestException('Rebind this server to the backup in your Cloud account first.');
    const incoming = parseBuddyKeyring(dto, vault.vaultId);
    await this.repository.locked('keyring', async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.BuddyBackup})`.execute(trx);
      const operations = new MediaOperationRepository(trx);
      const current = await this.keyring(vault.vaultId).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (current && Object.entries(current.keys).some(([version, key]) => incoming.keys[version] !== key))
        throw new ConflictException('Import must preserve every existing key version.');
      if (
        (await operations.getActiveOfKind(MediaOperationKind.BuddyBackup)) ||
        (await operations.getActiveOfKind(MediaOperationKind.BuddyRestore))
      )
        throw new ConflictException('Finish the active Buddy operation before importing a key.');
      await writeBuddyFile(join(this.repository.root(), `${incoming.vaultId}.keys.json`), JSON.stringify(incoming));
      await this.repository.update((state) => ({ ...state, recoveryVerified: true, probeVerified: false }), trx);
    });
    return this.status();
  }

  async rotateKit() {
    const ring = await this.keyring();
    return this.repository.locked('keyring', async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${DatabaseLock.BuddyBackup})`.execute(trx);
      const operations = new MediaOperationRepository(trx);
      if (
        (await operations.getActiveOfKind(MediaOperationKind.BuddyBackup)) ||
        (await operations.getActiveOfKind(MediaOperationKind.BuddyRestore))
      )
        throw new ConflictException('Finish the active Buddy operation before rotating the key.');
      const current = await this.keyring(ring.vaultId);
      const next = {
        ...current,
        current: current.current + 1,
        keys: { ...current.keys, [current.current + 1]: randomBytes(32).toString('base64url') },
      };
      parseBuddyKeyring(next, ring.vaultId);
      await writeBuddyFile(join(this.repository.root(), `${ring.vaultId}.keys.json`), JSON.stringify(next));
      await this.repository.update((state) => ({ ...state, recoveryVerified: false, probeVerified: false }), trx);
      return next;
    });
  }

  async invite(dto: BuddyInviteRequest) {
    const status = await this.status();
    if (!status.settings || dto.instanceId !== status.instanceId || dto.quotaBytes !== status.settings.quotaBytes)
      throw new BadRequestException('Configure your hosting capacity before sending this invitation.');
    return this.peer.cloud(BuddyInviteResponse, 'invitations', dto);
  }
  async accept(dto: BuddyAcceptRequest) {
    const status = await this.status();
    if (!status.settings || dto.instanceId !== status.instanceId || dto.quotaBytes !== status.settings.quotaBytes)
      throw new BadRequestException('Configure your hosting capacity before accepting this invitation.');
    await this.peer.cloud(BuddyPairing, 'invitations/accept', dto);
    await this.peer.pairing();
    return this.status();
  }
  async relationship(action: 'confirm' | 'end' | 'block') {
    const pairing = await this.peer.pairing();
    if (!pairing) throw new BadRequestException('No Buddy pairing is configured');
    const changed = await this.peer.cloud(BuddyPairing, `pairings/${pairing.pairId}/${action}`, { version: 1 });
    await this.repository.locked('peer-access', (trx) =>
      this.repository.update((state) => ({ ...state, pairing: changed }), trx),
    );
    return this.status();
  }

  client(scope: 'read' | 'write') {
    let grant: z.infer<typeof BuddyGrantResponse> | null = null;
    return Promise.resolve(
      new BuddyBackupClient(
        async () => {
          if (!grant || Date.parse(grant.expiresAt) < Date.now() + 30_000) grant = await this.peer.grant(scope);
          return grant;
        },
        () => this.peer.signer(),
        async (bytes, direction) => {
          const settings = (await this.repository.state()).settings;
          const mbps = (direction === 'upload' ? settings?.uploadMbps : settings?.downloadMbps) ?? 20;
          const units = Math.max(1, Math.ceil(bytes / (64 * 1024)));
          for (let unit = 0; unit < units; unit++) {
            const hit = await this.rates.hit(`buddy:bandwidth:${direction}`, 1);
            if (hit.count > Math.max(1, Math.floor((mbps * 1_000_000) / (8 * 64 * 1024))))
              await executionDelay(hit.resetSeconds * 1000);
          }
        },
      ),
    );
  }

  async probe() {
    const ring = await this.keyring();
    const root = Buffer.from(ring.keys[ring.current], 'base64url');
    const plain = randomBytes(64);
    const id = buddyObjectId(root, ring.vaultId, plain);
    const context = { vaultId: ring.vaultId, id, keyVersion: ring.current };
    const encrypted = encryptBuddyBlock(root, context, plain);
    await writeBuddyFile(join(this.repository.root(), 'probe', id), encrypted, true);
    const client = await this.client('write');
    await client.request('GET', 'handshake');
    await client.request('PUT', `objects/${id}`, undefined, encrypted);
    const returned = await client.request<Buffer>('GET', `objects/${id}`);
    if (!decryptBuddyBlock(root, context, returned).equals(plain)) throw new Error('Buddy encryption check failed');
    await rm(join(this.repository.root(), 'probe', id), { force: true });
    await this.repository.update((state) => ({
      ...state,
      probeVerified: true,
      transfer: { connection: client.connection, mbps: 0, at: new Date().toISOString() },
    }));
    return { ok: true };
  }

  async start(ownerId: string, verify = false) {
    await this.capture.reconcile();
    const state = await this.repository.state();
    if (!state.settings || !state.recoveryVerified)
      throw new BadRequestException('Configure hosting and verify your saved recovery kit first.');
    if (!verify) await this.peer.grant('write');
    if (!verify && !state.probeVerified) await this.probe();
    const ring = await this.keyring();
    const pairing = (await this.repository.state()).pairing!;
    const result = await this.operations.createExclusive(
      {
        ownerId,
        kind: MediaOperationKind.BuddyBackup,
        destination: MediaOperationDestination.Local,
        destinationDetail: null,
        label: verify ? 'Verify Buddy Backup' : 'Buddy Backup',
        assetId: null,
        resultAssetId: null,
        retryOfId: null,
        projectId: null,
        revisionId: null,
        snapshot: {
          version: 1,
          task: verify ? 'verify' : 'backup',
          pairId: pairing.pairId,
          vaultId: ring.vaultId,
          keyVersion: ring.current,
        },
        settings: {},
        estimate: null,
        result: {},
        totalUnits: null,
      },
      DatabaseLock.BuddyBackup,
    );
    if ('created' in result)
      await this.repository.update((current) => ({
        ...current,
        protectionStartedAt: current.protectionStartedAt ?? new Date().toISOString(),
        run: {
          id: result.created.id,
          state: 'capturing',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          uploadedBytes: 0,
          totalBytes: 0,
          objects: 0,
          uploadedObjects: 0,
          error: null,
        },
      }));
    this.tick();
    return this.status();
  }

  async control(auth: AuthDto, dto: BuddyControlDto) {
    const active = await this.operations.getActiveOfKind(MediaOperationKind.BuddyBackup);
    const current = active ? await this.operations.getOfKind(active.id, MediaOperationKind.BuddyBackup) : undefined;
    if (dto.action === 'start' || dto.action === 'verify') return this.start(auth.user.id, dto.action === 'verify');
    if (dto.action === 'restart') {
      await writeBuddyFile(join(this.repository.root(), 'restart.json'), JSON.stringify({ ownerId: auth.user.id }));
      if (current) await this.operations.requestCancel(current.id, current.ownerId);
    } else {
      const sending = dto.action.endsWith('sending');
      const paused = dto.action.startsWith('pause');
      await this.repository.locked('peer-access', (trx) =>
        this.repository.update(
          (state) => ({
            ...state,
            settings: state.settings
              ? { ...state.settings, ...(sending ? { pausedSending: paused } : { pausedReceiving: paused }) }
              : null,
          }),
          trx,
        ),
      );
      if (current && sending) {
        if (paused) await this.operations.requestPause(current.id, current.ownerId, KINDS);
        else await this.operations.resume(current.id, current.ownerId);
      }
    }
    this.tick();
    return this.status();
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.timer = setInterval(() => this.tick(), 30_000);
    this.tick();
  }
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.active;
  }
  tick() {
    if (this.active || this.stopped) return;
    this.active = this.drain()
      .catch(() => this.logger.warn('Buddy Backup worker is waiting; check its status.'))
      .finally(() => {
        this.active = undefined;
      });
  }

  private async drain() {
    if (Date.now() >= this.housekeepingAt) {
      this.housekeepingAt = Date.now() + 3_600_000;
      await this.housekeeping().catch(() =>
        this.logger.warn('Buddy protection checks are waiting for Cloud or local storage.'),
      );
    }
    const state = await this.repository.state();
    if (!state.settings) return;
    if (!(await this.operations.getActiveOfKind(MediaOperationKind.BuddyBackup))) {
      const restart = await readFile(join(this.repository.root(), 'restart.json'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        },
      );
      if (restart) {
        if (state.run) await this.capture.release(state.run.id);
        await this.start((JSON.parse(restart) as { ownerId: string }).ownerId);
        await rm(join(this.repository.root(), 'restart.json'));
      } else if (
        !state.settings.pausedSending &&
        process.env.FRAMELEAF_BUDDY_BACKUP === 'true' &&
        state.recoveryVerified
      ) {
        if (!state.nextScheduledAt)
          await this.repository.update((current) => ({
            ...current,
            nextScheduledAt: new CronTime(state.settings!.schedule, state.settings!.timezone).sendAt().toISO(),
          }));
        if (state.nextScheduledAt && Date.now() >= Date.parse(state.nextScheduledAt)) {
          const admin = await this.repository.db
            .selectFrom('user')
            .select('id')
            .where('isAdmin', '=', true)
            .where('deletedAt', 'is', null)
            .executeTakeFirst();
          if (admin) await this.start(admin.id);
          await this.repository.update((current) => ({
            ...current,
            nextScheduledAt: new CronTime(state.settings!.schedule, state.settings!.timezone).sendAt().toISO(),
          }));
        } else if (
          state.lastCompleteAt &&
          (!state.lastVerifiedAt || Date.parse(state.lastVerifiedAt) < Date.now() - 7 * 86_400_000)
        ) {
          const admin = await this.repository.db
            .selectFrom('user')
            .select('id')
            .where('isAdmin', '=', true)
            .where('deletedAt', 'is', null)
            .executeTakeFirst();
          if (admin) await this.start(admin.id, true);
        }
      }
    }
    const restore = await this.operations.getActiveOfKind(MediaOperationKind.BuddyRestore);
    if (restore) return;
    const claim = await this.operations.claimNext({
      kinds: [MediaOperationKind.BuddyBackup],
      workerId: `buddy-${process.pid}`,
      leaseMs: LEASE_MS,
    });
    if (claim) await this.run(claim.operation, claim.claimToken);
  }

  private async run(operation: MediaOperation, token: string) {
    return withOperationExecution(
      {
        renew: () => this.operations.heartbeat(operation.id, token, LEASE_MS, { requireActiveClaim: true }),
        stopped: () => this.stopped,
      },
      () => this.runClaim(operation, token),
    );
  }

  private async runClaim(operation: MediaOperation, token: string) {
    const id = operation.id;
    let cancelled = false;
    try {
      if (
        !(await this.operations.reportProgress(id, token, {
          status: MediaOperationStatus.Rendering,
          processedUnits: 0,
          totalUnits: null,
          progress: 0,
        }))
      )
        throw new BuddyStopped();
      const checkpoint = async () => {
        assertExecutionActive();
        const state = await this.repository.state();
        const row = await this.operations.getOfKind(id, MediaOperationKind.BuddyBackup);
        cancelled = !!row?.cancelRequestedAt;
        const bound = operation.snapshot as { pairId: string; vaultId: string; keyVersion: number; task: string };
        if (
          state.pairing?.pairId !== bound.pairId ||
          state.pairing.vaults.every((vault) => vault.vaultId !== bound.vaultId) ||
          state.pairing.state === 'blocked' ||
          (bound.task === 'backup' &&
            (state.pairing.state !== 'active' || process.env.FRAMELEAF_BUDDY_BACKUP !== 'true'))
        )
          throw new BuddyStopped();
        if (
          this.stopped ||
          !row ||
          row.claimToken !== token ||
          cancelled ||
          row.pauseRequestedAt ||
          state.settings?.pausedSending
        )
          throw new BuddyStopped();
        const time = new Intl.DateTimeFormat('en-GB', {
          timeZone: state.settings!.timezone,
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(new Date());
        const { windowStart: start, windowEnd: end } = state.settings!;
        const inside = start === end || (start < end ? time >= start && time < end : time >= start || time < end);
        if (!inside || (await this.operations.getActiveOfKind(MediaOperationKind.BuddyRestore)))
          throw new BuddyStopped();
      };
      await checkpoint();
      const ring = await this.keyring();
      if (ring.vaultId !== operation.snapshot.vaultId || ring.current !== operation.snapshot.keyVersion)
        throw new Error('Buddy key changed during the run');
      const state = await this.repository.state();
      const client = await this.client((operation.snapshot as { task?: string }).task === 'verify' ? 'read' : 'write');
      await client.request('GET', 'handshake');
      const snapshots = await client.request<
        Array<{ id: string; sequence: number; createdAt: string; keyVersion: number }>
      >('GET', 'snapshots');
      if ((snapshots[0]?.sequence ?? 0) < state.lastSequence)
        throw new Error('Buddy returned an older snapshot than this server has already verified');
      if ((operation.snapshot as { task?: string }).task === 'verify') {
        const newest = snapshots[0];
        if (!newest) throw new Error('There is no complete Buddy snapshot to verify');
        const envelope = await client.request<BuddySignedSnapshot>('GET', `snapshots/${newest.id}`);
        const reader = new BuddyBackupReader(ring, envelope, (id) => client.request<Buffer>('GET', `objects/${id}`), {
          signal: executionSignal(),
          progress: advanceExecutionProgress,
        });
        const manifest = await reader.manifest();
        const selected = envelope.snapshot.objects.filter(
          (_, index) => index % 52 === Math.floor(Date.now() / (7 * 86_400_000)) % 52,
        );
        const sample = selected.length > 0 ? selected : envelope.snapshot.objects.slice(0, 1);
        for (const receipt of sample) {
          await checkpoint();
          const encrypted = await client.request<Buffer>('GET', `objects/${receipt.id}`);
          decryptBuddyBlock(
            Buffer.from(ring.keys[envelope.snapshot.keyVersion], 'base64url'),
            { vaultId: ring.vaultId, id: receipt.id, keyVersion: envelope.snapshot.keyVersion },
            encrypted,
          );
        }
        const files = Object.entries(manifest.contents);
        const chosen = files[Math.floor(Date.now() / (7 * 86_400_000)) % files.length];
        if (!chosen) throw new Error('The Buddy snapshot has no recoverable content');
        const isolated = join(this.repository.root(), 'verification', operation.id);
        try {
          await checkpoint();
          await reader.download(manifest, chosen[0], join(isolated, 'sample'));
        } finally {
          await rm(isolated, { force: true, recursive: true });
        }
        await this.repository.update((current) => ({ ...current, lastVerifiedAt: new Date().toISOString() }));
      } else {
        const captured = await this.capture.capture({
          runId: id,
          instanceId: (await this.peer.identity()).instanceId,
          sequence: (snapshots[0]?.sequence ?? 0) + 1,
          previous: snapshots[0]?.id ?? null,
          ring,
          settings: state.settings!,
          checkpoint,
        });
        let uploadedBytes = 0;
        let uploadedObjects = 0;
        const totalBytes = captured.objects.reduce((sum, receipt) => sum + receipt.bytes, 0);
        for (let offset = 0; offset < captured.objects.length; offset += 100) {
          await checkpoint();
          const page = captured.objects.slice(offset, offset + 100);
          const found = new Map(
            (await client.request<BuddyReceipt[]>('POST', 'inventory', { ids: page.map((receipt) => receipt.id) })).map(
              (receipt) => [receipt.id, receipt],
            ),
          );
          for (let at = 0; at < page.length; at += 2) {
            const started = Date.now();
            const before = uploadedBytes;
            const results = await Promise.allSettled(
              page.slice(at, at + 2).map(async (receipt) => {
                await checkpoint();
                const stored = found.get(receipt.id);
                if (stored && (stored.digest !== receipt.digest || stored.bytes !== receipt.bytes))
                  throw new Error('Buddy object differs from the captured checkpoint');
                if (!stored) {
                  await client.request('POST', 'reservations', receipt);
                  await client.request(
                    'PUT',
                    `objects/${receipt.id}`,
                    undefined,
                    await readFile(this.capture.blockPath(receipt.id, id)),
                  );
                  uploadedBytes += receipt.bytes;
                }
                uploadedObjects++;
              }),
            );
            const failed = results.find((result) => result.status === 'rejected');
            if (failed?.status === 'rejected') throw failed.reason;
            await this.repository.update((current) => ({
              ...current,
              transfer: {
                connection: client.connection,
                mbps: ((uploadedBytes - before) * 8) / (Math.max(1, Date.now() - started) * 1000),
                at: new Date().toISOString(),
              },
              run: current.run && {
                ...current.run,
                state: 'sending',
                uploadedBytes,
                uploadedObjects,
                objects: captured.objects.length,
                totalBytes,
              },
            }));
            await this.operations.setBulkResult(id, token, {
              result: { uploadedBytes, uploadedObjects },
              processedUnits: uploadedObjects,
              totalUnits: captured.objects.length,
              progress: (100 * uploadedObjects) / captured.objects.length,
              leaseMs: LEASE_MS,
            });
          }
        }
        await checkpoint();
        const snapshot = {
          version: 1 as const,
          vaultId: ring.vaultId,
          id: captured.manifest.snapshotId,
          sequence: captured.manifest.sequence,
          previous: captured.manifest.previous,
          createdAt: new Date().toISOString(),
          retainUntil: new Date(Date.now() + 31 * 86_400_000).toISOString(),
          keyVersion: ring.current,
          manifest: captured.manifestBlocks,
          objects: captured.objects,
        };
        const envelopePath = join(this.capture.runDirectory(id), 'envelope.json');
        let envelope: BuddySignedSnapshot;
        try {
          envelope = JSON.parse(await readFile(envelopePath, 'utf8'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          envelope = {
            snapshot,
            signature: this.peer.signer().signBytes!(buddySnapshotBytes(snapshot)).toString('base64url'),
          };
          await writeBuddyFile(envelopePath, JSON.stringify(envelope), true);
        }
        const receipt = await client.request('POST', 'snapshots', envelope);
        assertBuddyCommitReceipt(receipt, envelope);
        await this.repository.update((current) => ({
          ...current,
          lastCompleteAt: snapshot.createdAt,
          lastSequence: snapshot.sequence,
        }));
      }
      await this.repository.update((current) => ({
        ...current,
        transfer: { connection: client.connection, mbps: 0, at: new Date().toISOString() },
      }));
      await this.operations.beginValidation(id, token, true);
      if (!(await this.operations.complete(id, token, { resultAssetId: null }, undefined, true)))
        throw new BuddyStopped();
      await this.repository.update((current) => ({
        ...current,
        run: current.run && { ...current.run, state: 'complete', error: null, finishedAt: new Date().toISOString() },
      }));
      await this.capture.release(id);
    } catch (caughtError) {
      const error = executionSignal()?.aborted ? executionSignal()!.reason : caughtError;
      if (await settleOperationStop(this.operations, operation, token)) return;
      if (error instanceof BuddyStopped) {
        if (cancelled) {
          await this.capture.release(id);
          await this.operations.acknowledgeCancel(id, token, { released: true });
        } else {
          await this.operations.requeue(id, token, { delayMs: 30_000, returnAttempt: true });
        }
        await this.repository.update((current) => ({
          ...current,
          run: current.run && { ...current.run, state: 'paused' },
        }));
      } else {
        const waiting =
          error instanceof BuddyPeerUnavailable ||
          (error instanceof FrameleafCloudError && [401, 403, 429, 507].includes(error.status ?? 0))
            ? (error as BuddyPeerUnavailable | FrameleafCloudError)
            : null;
        const retry =
          error instanceof BuddyExecutionError ||
          error instanceof OperationDeadlineError ||
          (error instanceof FrameleafCloudError && (error.status === null || error.status >= 500));
        const message = waiting
          ? waiting.message
          : 'Backup is incomplete. Check required mounts, source integrity, recovery keys, and local staging space.';
        const update = (current: BuddyState): BuddyState => ({
          ...current,
          run:
            current.run?.id === id
              ? {
                  ...current.run,
                  state: waiting
                    ? waiting.status === 507
                      ? 'waiting-quota'
                      : waiting.status === 401 || waiting.status === 403
                        ? 'waiting-authorization'
                        : 'waiting-peer'
                    : 'incomplete',
                  error: message,
                }
              : current.run,
        });
        if (waiting) {
          // The successful requeue retains its row lock through the state write.
          // A replacement cannot claim this same operation until publication finishes.
          if (
            !(await this.operations.requeue(
              id,
              token,
              { delayMs: 60_000 + Math.floor(Math.random() * 60_000), returnAttempt: true },
              async (trx) => {
                await this.repository.update(update, trx);
              },
            ))
          )
            return;
        } else {
          await this.repository.update(update);
          await this.operations.fail(id, token, { error: message, errorCode: 'buddy_incomplete' }, { retry });
          await this.capture.reconcile();
        }
        await this.events.emit('AdminNotify', {
          type: NotificationType.SystemMessage,
          level: NotificationLevel.Warning,
          title: 'Buddy Backup needs attention',
          description: message,
          dedupeKey: 'buddy:incomplete',
          dedupeDays: 1,
        });
      }
    }
  }

  private async housekeeping() {
    await this.capture.reconcile();
    await this.peer
      .pairing()
      .catch(() => this.logger.warn('Buddy Cloud status refresh is unavailable. Local retention still runs.'));
    const state = await this.repository.state();
    if (!state.settings || !state.pairing) return;
    const identity = await this.peer.identity();
    const hosted = state.pairing.vaults.find((vault) => vault.destinationInstanceId === identity.instanceId)!;
    const usage = await this.repository.locked(hosted.vaultId, async () => {
      const vault = new BuddyVault(state.settings!.directory, hosted.vaultId);
      await vault.prune(Date.now());
      return vault.usage();
    });
    const fs = await statfs(state.settings.directory);
    const alert = async (
      key: string,
      title: string,
      description: string,
      systemTemplate?: SystemNotificationTemplate,
    ) =>
      this.events.emit('AdminNotify', {
        type: NotificationType.SystemMessage,
        level: NotificationLevel.Warning,
        title,
        description,
        systemTemplate,
        dedupeKey: `buddy:${key}`,
        dedupeDays: 1,
      });
    const protectedSince = state.lastCompleteAt ?? state.protectionStartedAt ?? state.run?.startedAt;
    if (protectedSince && Date.parse(protectedSince) < Date.now() - 3 * 86_400_000)
      await alert(
        'stale',
        'Buddy Backup is out of date',
        state.lastCompleteAt
          ? 'Your last complete restore point is more than three days old. Check the sending status.'
          : 'Buddy Backup has not completed its first restore point after three days. Check the sending status.',
        { version: 1, key: state.lastCompleteAt ? 'buddy-backup-stale' : 'buddy-backup-first-stale', args: {} },
      );
    if (usage.committedBytes + usage.reservedBytes > hosted.quotaBytes * 0.9 || fs.bavail / fs.blocks < 0.15)
      await alert(
        'capacity',
        'Buddy storage is running low',
        'Increase the hosting capacity or free space on the volume. Retained backups will not be deleted to make room.',
        { version: 1, key: 'buddy-storage-low', args: {} },
      );
    if (state.pairing.state === 'ended')
      await alert(
        'ended',
        'Your Buddy pairing has ended',
        `Recover your backup before ${state.pairing.readUntil}. New backups have stopped.`,
        state.pairing.readUntil
          ? { version: 1, key: 'buddy-pairing-ended', args: { readUntil: state.pairing.readUntil } }
          : undefined,
      );
    else if (state.pairing.state === 'blocked')
      await alert(
        'blocked',
        'Buddy access was blocked',
        'The hosted encrypted vault remains on disk. Contact your buddy to arrange recovery.',
        { version: 1, key: 'buddy-access-blocked', args: {} },
      );
    await this.peer.cloud(BuddyAction, 'status', {
      version: 1,
      pairId: state.pairing.pairId,
      vaultId: hosted.vaultId,
      ...usage,
      lastCompleteAt: null,
      lastVerifiedAt: null,
      state: 'idle',
    });
    const source = state.pairing.vaults.find((vault) => vault.sourceInstanceId === identity.instanceId)!;
    await this.peer.cloud(BuddyAction, 'status', {
      version: 1,
      pairId: state.pairing.pairId,
      vaultId: source.vaultId,
      committedBytes: 0,
      reservedBytes: 0,
      lastCompleteAt: state.lastCompleteAt,
      lastVerifiedAt: state.lastVerifiedAt,
      state: state.settings.pausedSending
        ? 'paused'
        : state.run?.state === 'sending'
          ? 'sending'
          : state.run?.state === 'waiting-quota'
            ? 'quota'
            : state.run?.state === 'incomplete'
              ? 'integrity'
              : 'idle',
    });
    const reports = await this.peer.cloud(BuddyStatusResponse, 'status');
    const report = reports.reports.find((report) => report.vaultId === source.vaultId);
    if (report)
      await this.repository.update((current) => ({
        ...current,
        peerUsage: {
          vaultId: report.vaultId,
          committedBytes: report.committedBytes,
          reservedBytes: report.reservedBytes,
          at: new Date().toISOString(),
        },
      }));
  }
}
