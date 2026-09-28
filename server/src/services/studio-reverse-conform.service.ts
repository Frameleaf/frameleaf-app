import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  ImmichWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
} from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioReverseConformRepository } from 'src/repositories/studio-reverse-conform.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioAuthorizedEntry, StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioDestination, StudioResourceKind, isStudioUuid } from 'src/utils/studio-resources.js';
import { checkStudioReverseOutput, checkStudioReverseSource } from 'src/utils/studio-reverse-conform.js';

const LEASE_MS = 120_000;
const TICK_MS = 5000;
type ReverseSnapshot = {
  kind: 'studio-source-reverse';
  projectId: string;
  revision: number;
  digest: string;
  sourceKey: string;
  checksum: string;
};
type Job = { operation: MediaOperation; claimToken: string };

/** Internal producer only. No clip command or endpoint is enabled until its relink adapter exists. */
@Injectable()
export class StudioReverseConformService {
  private readonly workerId = `studio-reverse-${randomUUID()}`;
  private stopping = false;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private abort?: AbortController;

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private projects: StudioProjectRepository,
    private studio: StudioProjectService,
    private resources: StudioResourceService,
    private users: UserRepository,
    private media: MediaRepository,
    private renderer: StudioReverseConformRepository,
    private storage: StorageRepository,
    private crypto: CryptoRepository,
  ) {
    this.logger.setContext(StudioReverseConformService.name);
  }

  /** A source-level request, deliberately not job.enqueueReverseConform's clip payload. */
  async enqueueSource(
    auth: AuthDto,
    input: { projectId: string; revision: number; sourceKey: string; destination: StudioDestination },
  ): Promise<MediaOperation> {
    if (input.destination !== StudioDestination.Local) {
      throw new BadRequestException(
        'Source reversal is available only on this server; LAN and cloud are not qualified',
      );
    }
    if (
      !isStudioUuid(input.projectId) ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      typeof input.sourceKey !== 'string'
    ) {
      throw new BadRequestException('Source reversal requires an explicit stored project revision and source key');
    }
    const resolved = await this.source(auth, input.projectId, input.revision, input.sourceKey);
    const plan = await this.inspect(resolved.entry);
    const snapshot: ReverseSnapshot = {
      kind: 'studio-source-reverse',
      projectId: input.projectId,
      revision: input.revision,
      digest: resolved.digest,
      sourceKey: input.sourceKey,
      checksum: resolved.entry.checksum!,
    };
    return this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.StudioReverseConform,
      destination: MediaOperationDestination.Local,
      destinationDetail: null,
      label: 'Source reversal',
      assetId: resolved.entry.id,
      resultAssetId: null,
      retryOfId: null,
      projectId: input.projectId,
      revisionId: resolved.revisionId,
      snapshot,
      settings: { sourceLevel: true, requiresClipRelink: true },
      estimate: null,
      totalUnits: plan.frames,
      maxAttempts: 2,
    });
  }

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.timer ??= setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort(new Error('Worker stopping'));
    await this.active;
  }

  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch(() => this.logger.warn('Local source reversal worker failed'))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain() {
    while (!this.stopping) {
      const job = await this.operations.claimNext({
        kinds: [MediaOperationKind.StudioReverseConform],
        workerId: this.workerId,
        leaseMs: LEASE_MS,
      });
      if (!job) {
        return;
      }
      await this.run(job);
    }
  }

  /** Each claim writes its own private file; an old worker can never overwrite a replacement. */
  async run({ operation, claimToken }: Job): Promise<void> {
    if (!isStudioUuid(operation.id) || !isStudioUuid(operation.ownerId) || !isStudioUuid(claimToken)) {
      return;
    }
    const folder = join(
      StorageCore.getFolderLocation(StorageFolder.Exports, operation.ownerId),
      'studio-generated',
      operation.id,
      claimToken,
    );
    const path = join(folder, 'source-reversed.mkv');
    const generatedId = `reverse-${operation.id}`;
    const controller = new AbortController();
    this.abort = controller;
    let published = false;
    let frames = 0;
    let total = 0;
    let stage = MediaOperationStatus.Preparing;
    let writing: Promise<void> | undefined;
    const monitor = async () => {
      const held = await this.operations.getForWorker(operation.id);
      if (
        !held ||
        held.claimToken !== claimToken ||
        !held.claimExpiresAt ||
        new Date(held.claimExpiresAt).getTime() <= Date.now() ||
        held.status === MediaOperationStatus.Cancelling
      ) {
        controller.abort(new Error('Claim lost or cancelled'));
        return;
      }
      if (
        !(await this.operations.heartbeat(operation.id, claimToken, LEASE_MS)) ||
        !(await this.operations.reportProgress(operation.id, claimToken, {
          status: stage,
          processedUnits: frames,
          totalUnits: total || null,
          progress: total ? Math.min(95, (frames / total) * 95) : 0,
        }))
      ) {
        controller.abort(new Error('Claim lost or cancelled'));
      }
    };
    const heartbeat = setInterval(() => {
      writing ??= monitor()
        .catch(() => {
          controller.abort(new Error('Claim heartbeat failed'));
        })
        .finally(() => {
          writing = undefined;
        });
    }, TICK_MS);
    try {
      await monitor();
      controller.signal.throwIfAborted();
      const snapshot = this.snapshot(operation);
      const auth = await this.owner(operation.ownerId);
      const original = await this.source(auth, snapshot.projectId, snapshot.revision, snapshot.sourceKey, true);
      this.requireBinding(snapshot, original);
      const plan = await this.inspect(original.entry);
      total = plan.frames;
      controller.signal.throwIfAborted();
      this.storage.mkdirSync(folder);
      stage = MediaOperationStatus.Rendering;
      await monitor();
      controller.signal.throwIfAborted();
      await this.renderer.reverse(original.entry.path!, path, plan, controller.signal, (value) => {
        frames = value;
      });
      // Stop rendering progress before entering validation; a late report cannot move its stage back.
      clearInterval(heartbeat);
      await writing;
      controller.signal.throwIfAborted();
      if (!(await this.operations.beginValidation(operation.id, claimToken))) {
        throw new Error('Claim lost');
      }
      const stat = await this.storage.stat(path);
      if (!stat.isFile() || stat.size === 0) {
        throw new Error('Missing reversed file');
      }
      checkStudioReverseOutput(plan, await this.media.probe(path, { countFrames: true }));
      const checksum = (await this.crypto.hashFile(path, 'sha256')).toString('hex');
      const current = await this.source(auth, snapshot.projectId, snapshot.revision, snapshot.sourceKey, true);
      this.requireBinding(snapshot, current);
      await this.checkBytes(current.entry);
      const result = {
        kind: 'studio-source-reverse',
        generatedId,
        sourceKey: snapshot.sourceKey,
        sourceRevision: snapshot.revision,
        sourceRevisionDigest: snapshot.digest,
        sourceLevel: true,
        requiresClipRelink: true,
        frames: plan.frames,
        frameRate: plan.frameRate,
        width: plan.width,
        height: plan.height,
        // A clip adapter must mirror its source interval and preserve its timeline duration/effects.
        sourceIntervalMapping: 'reversedStart = sourceDuration - sourceEnd; reversedEnd = sourceDuration - sourceStart',
      };
      const outcome = await this.operations.publishValidated(operation.id, claimToken, async (tx) => {
        // publishValidated holds the claim row. Also reject an expired lease, even before recovery takes it.
        const held = await tx
          .selectFrom('media_operation')
          .select('id')
          .where('id', '=', operation.id)
          .where('claimToken', '=', claimToken)
          .where('claimExpiresAt', '>', sql<Date>`clock_timestamp()`)
          .executeTakeFirst();
        if (!held) {
          return false;
        }
        // The first producer admits only the owner's original. Hold deletion/trash off until commit.
        const asset = await tx
          .selectFrom('asset')
          .select('id')
          .where('id', '=', current.entry.id)
          .where('ownerId', '=', operation.ownerId)
          .where('checksum', '=', Buffer.from(snapshot.checksum, 'base64'))
          .where('deletedAt', 'is', null)
          .forShare()
          .executeTakeFirst();
        if (!asset) {
          return false;
        }
        await this.projects.registerGeneratedResource(
          {
            projectId: snapshot.projectId,
            ownerId: operation.ownerId,
            sourceRevision: snapshot.revision,
            id: generatedId,
            producer: 'reverse-conform',
            checksum,
            path,
            derivedFrom: [current.entry.key],
          },
          tx,
        );
        await tx.updateTable('media_operation').set({ result }).where('id', '=', operation.id).execute();
        return true;
      });
      published = outcome === 'completed';
      if (!published) {
        throw new Error('Claim or source lost before publication');
      }
      this.studio.forgetResolutions([snapshot.projectId]);
    } catch (error) {
      const held = await this.operations.getForWorker(operation.id);
      if (held?.claimToken === claimToken && held.status === MediaOperationStatus.Cancelling) {
        await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
      } else {
        await this.operations.fail(operation.id, claimToken, {
          errorCode: 'studio_reverse_conform_failed',
          error:
            error instanceof BadRequestException
              ? error.message
              : 'Local source reversal failed; no result was published',
        });
      }
    } finally {
      clearInterval(heartbeat);
      await writing;
      if (this.abort === controller) {
        this.abort = undefined;
      }
      if (!published) {
        // A lost commit acknowledgement is not evidence of rollback. Preserve registered bytes, or
        // leave them for recovery when the database cannot answer; never delete a committed output.
        const finalState = await this.operations.getForWorker(operation.id).catch(() => {});
        const declarations = operation.projectId
          ? await this.projects.listGeneratedResources(operation.projectId).catch(() => {})
          : undefined;
        // Trashed projects intentionally hide their declarations. The completed job remains the
        // authority in that case; an empty visible list must never delete its committed output.
        if (
          finalState &&
          finalState.status !== MediaOperationStatus.Completed &&
          declarations &&
          declarations.every((entry) => entry.path !== path)
        ) {
          await this.storage.unlinkDir(folder, { recursive: true, force: true }).catch(() => {});
        }
      }
    }
  }

  private snapshot(operation: MediaOperation): ReverseSnapshot {
    const snapshot = operation.snapshot as Partial<ReverseSnapshot> | null;
    if (
      operation.kind !== MediaOperationKind.StudioReverseConform ||
      operation.destination !== MediaOperationDestination.Local ||
      snapshot?.kind !== 'studio-source-reverse' ||
      snapshot.projectId !== operation.projectId ||
      !isStudioUuid(snapshot.projectId) ||
      !Number.isSafeInteger(snapshot.revision) ||
      snapshot.revision! < 1 ||
      typeof snapshot.digest !== 'string' ||
      typeof snapshot.sourceKey !== 'string' ||
      typeof snapshot.checksum !== 'string'
    ) {
      throw new BadRequestException('Invalid local source reversal snapshot');
    }
    return snapshot as ReverseSnapshot;
  }

  private async source(
    auth: AuthDto,
    projectId: string,
    revision: number,
    sourceKey: string,
    backgroundRunner = false,
  ) {
    const authorized = await this.studio.authorizeRevision(auth, {
      projectId,
      revision,
      destination: StudioDestination.Local,
    });
    if (authorized.project.ownerId !== auth.user.id || authorized.project.archivedAt) {
      throw new ForbiddenException('Only an active project owner may reverse its sources');
    }
    // Fresh current access, including every declared dependency; do not reuse a manifest cached at submit.
    const resolution = await this.resources.resolveProjectResources(auth, {
      projectId,
      ownerId: auth.user.id,
      revision,
      graph: authorized.envelope.graph,
      generated: await this.projects.listGeneratedResources(projectId),
      destination: StudioDestination.Local,
      backgroundRunner,
    });
    const entry = resolution.manifest.entries.find((item) => item.key === sourceKey);
    // Library entries use the resolver's base64 checksum encoding; generated declarations use hex.
    const checksumBytes = entry?.checksum ? Buffer.from(entry.checksum, 'base64') : null;
    if (
      !resolution.manifest.complete ||
      !entry ||
      entry.kind !== StudioResourceKind.LibraryAsset ||
      entry.ownerId !== auth.user.id ||
      entry.sourceAccess !== 'owner' ||
      !entry.path ||
      !entry.checksum ||
      !checksumBytes ||
      ![20, 32].includes(checksumBytes.length) ||
      checksumBytes.toString('base64') !== entry.checksum
    ) {
      throw new BadRequestException(
        'The complete source manifest is unavailable, or this source is not an owned library original',
      );
    }
    return { entry, digest: authorized.revision.digest, revisionId: authorized.revision.id };
  }

  private requireBinding(snapshot: ReverseSnapshot, resolved: { entry: StudioAuthorizedEntry; digest: string }) {
    if (resolved.digest !== snapshot.digest || resolved.entry.checksum !== snapshot.checksum) {
      throw new BadRequestException('The source revision or source bytes changed');
    }
  }

  private async checkBytes(entry: StudioAuthorizedEntry) {
    const expected = Buffer.from(entry.checksum!, 'base64');
    if (!(await this.crypto.hashFileMatching(entry.path!, expected)).equals(expected)) {
      throw new BadRequestException('The source bytes do not match the authorized checksum');
    }
  }

  private async inspect(entry: StudioAuthorizedEntry) {
    const stat = await this.storage.stat(entry.path!);
    if (!stat.isFile() || stat.size === 0 || stat.size > 256 * 1024 * 1024) {
      throw new BadRequestException('Local source reversal accepts files up to 256 MiB');
    }
    await this.checkBytes(entry);
    const info = await this.media.probe(entry.path!);
    if (
      !info.videoStreams[0] ||
      !Number.isFinite(info.format.duration) ||
      info.format.duration <= 0 ||
      info.format.duration > 10
    ) {
      throw new BadRequestException('Local source reversal accepts video up to ten seconds');
    }
    const streamIndex = info.videoStreams[0].index;
    const geometry = await this.renderer.probeGeometry(entry.path!, streamIndex);
    return checkStudioReverseSource(info, await this.media.probePackets(entry.path!, streamIndex), geometry);
  }

  private async owner(ownerId: string): Promise<AuthDto> {
    const user = await this.users.get(ownerId, { withDeleted: false });
    if (!user) {
      throw new BadRequestException('The source owner is unavailable');
    }
    // Like an export, this is the owner's submitted background job (FL-195), not a viewer grant.
    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
      },
      session: { id: this.workerId, hasElevatedPermission: true },
    };
  }
}
