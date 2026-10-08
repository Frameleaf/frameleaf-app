import type { SourceEpoch } from 'src/repositories/asset-local-effect.repository.js';
import { isDeepStrictEqual } from 'node:util';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import {
  StudioReverseConformResultDto,
  StudioReverseConformResultSchema,
} from 'src/dtos/studio-reverse-conform.dto.js';
import {
  ImmichWorker,
  MediaOperationDestination,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
} from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MediaOperation,
  MediaOperationCreate,
  MediaOperationRepository,
} from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StudioReverseConformRepository } from 'src/repositories/studio-reverse-conform.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioAuthorizedEntry, StudioResourceService } from 'src/services/studio-resource.service.js';
import { StudioDestination, StudioResourceKind, isStudioUuid } from 'src/utils/studio-resources.js';
import { checkReverseClipSource } from 'src/utils/studio-reverse-clip.js';
import {
  checkStudioReverseOutput,
  checkStudioReversePreview,
  checkStudioReverseSource,
} from 'src/utils/studio-reverse-conform.js';

const LEASE_MS = 120_000;
const TICK_MS = 5000;
type ReverseSnapshot = {
  kind: 'studio-source-reverse';
  projectId: string;
  revision: number;
  digest: string;
  sourceKey: string;
  checksum: string;
  sourceEpochs?: SourceEpoch[];
};
type Job = { operation: MediaOperation; claimToken: string };

/** Internal local producer; command binding is handled by StudioReverseConformCommandService. */
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

  /** Source-level work; an optional command binding is derived from the stored graph by the adapter. */
  async enqueueSource(
    auth: AuthDto,
    input: {
      projectId: string;
      revision: number;
      sourceKey: string;
      destination: StudioDestination;
      command?: { clipId: string; clientId: string; requestKey: string };
    },
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
    if (input.command) {
      const clip = checkReverseClipSource(resolved.graph, input.command.clipId, plan);
      if (`library-asset:${clip.assetId}` !== input.sourceKey) {
        throw new BadRequestException('The command clip does not name this source');
      }
    }
    const snapshot: ReverseSnapshot = {
      kind: 'studio-source-reverse',
      projectId: input.projectId,
      revision: input.revision,
      digest: resolved.digest,
      sourceKey: input.sourceKey,
      checksum: resolved.entry.checksum!,
      sourceEpochs: resolved.sourceEpochs?.filter(row => row.assetId === resolved.entry.id),
    };
    const operation: MediaOperationCreate = {
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
      snapshot: input.command ? { ...snapshot, ...input.command } : snapshot,
      settings: { sourceLevel: true, requiresClipRelink: true },
      estimate: null,
      totalUnits: plan.frames,
      maxAttempts: 2,
    };
    return input.command
      ? this.operations.createStudioReverseCommand(operation, { ...input.command, revision: input.revision })
      : this.operations.create(operation);
  }

  private async authorizePreview(auth: AuthDto, id: string) {
    if (auth.sharedLink) {
      throw new NotFoundException('Reverse preview not found');
    }
    const operation = await this.operations.getForOwner(id, auth.user.id);
    if (!operation || operation.ownerId !== auth.user.id || operation.status !== MediaOperationStatus.Completed) {
      throw new NotFoundException('Reverse preview not found');
    }
    const snapshot = this.snapshot(operation);
    this.requireBinding(snapshot, await this.source(auth, snapshot.projectId, snapshot.revision, snapshot.sourceKey));

    const declarations = await this.projects.listGeneratedResources(snapshot.projectId);
    const masterId = `reverse-${operation.id}`;
    const master = declarations.find((entry) => entry.id === masterId);
    const preview = declarations.find((entry) => entry.id === `reverse-preview-${operation.id}`);
    if (
      master?.producer !== 'reverse-conform' ||
      master.derivedFrom.length !== 1 ||
      master.derivedFrom[0] !== snapshot.sourceKey ||
      preview?.producer !== 'proxy' ||
      !preview.checksum ||
      !/^[a-f0-9]{64}$/.test(preview.checksum) ||
      preview.derivedFrom.length !== 2 ||
      preview.derivedFrom[0] !== `${StudioResourceKind.GeneratedIntermediate}:${masterId}` ||
      preview.derivedFrom[1] !== snapshot.sourceKey
    ) {
      throw new NotFoundException('Reverse preview not found');
    }

    return { operation, snapshot, preview };
  }

  /** Metadata is authorized like the bytes; stored worker results are never returned verbatim. */
  async getResult(auth: AuthDto, id: string): Promise<StudioReverseConformResultDto> {
    const { operation, snapshot, preview } = await this.authorizePreview(auth, id);
    const result = operation.result as Record<string, unknown> | null;
    const parsed = StudioReverseConformResultSchema.safeParse({
      ...result,
      operationId: operation.id,
      projectId: snapshot.projectId,
      clipId: (operation.snapshot as Record<string, unknown>).clipId ?? null,
    });
    const lineage = (result?.browserPreview as Record<string, unknown> | undefined)?.derivedFrom;
    if (
      !parsed.success ||
      result?.kind !== 'studio-source-reverse' ||
      result.sourceKey !== snapshot.sourceKey ||
      result.sourceRevision !== snapshot.revision ||
      result.sourceRevisionDigest !== snapshot.digest ||
      result.sourceLevel !== true ||
      result.requiresClipRelink !== true ||
      parsed.data.generatedId !== `reverse-${operation.id}` ||
      parsed.data.browserPreview.generatedId !== preview.id ||
      parsed.data.browserPreview.checksum !== preview.checksum ||
      !Array.isArray(lineage) ||
      lineage.length !== preview.derivedFrom.length ||
      lineage.some((key, index) => key !== preview.derivedFrom[index])
    ) {
      throw new NotFoundException('Reverse result not found');
    }
    return parsed.data;
  }

  /** Interactive owner read; a worker grant never authorizes browser delivery. */
  async readPreview(auth: AuthDto, id: string): Promise<Buffer> {
    const { snapshot, preview } = await this.authorizePreview(auth, id);
    // ponytail: buffer the producer's 64 MiB maximum; use verified temporary files if that limit grows.
    // One descriptor and a bounded buffer: hashing a path then letting Express reopen it could
    // serve different bytes. Read one extra byte to refuse a file that grew after the size check.
    const file = await this.storage.openForRandomRead(preview.path);
    let bytes: Buffer;
    try {
      const byteCount = file.size;
      if (byteCount <= 0 || byteCount > 64 * 1024 * 1024) {
        throw new NotFoundException('Reverse preview not found');
      }
      bytes = await file.read(0, byteCount + 1);
      if (bytes.length !== byteCount || createHash('sha256').update(bytes).digest('hex') !== preview.checksum) {
        throw new NotFoundException('Reverse preview not found');
      }
    } finally {
      await file.close();
    }

    // Access may change during disk I/O. Re-resolve interactively before releasing the bytes.
    this.requireBinding(snapshot, await this.source(auth, snapshot.projectId, snapshot.revision, snapshot.sourceKey));
    return bytes;
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
    const previewPath = join(folder, 'source-reversed-preview.mp4');
    const previewId = `reverse-preview-${operation.id}`;
    const controller = new AbortController();
    this.abort = controller;
    // Shutdown can begin while claimNext is pending, before there is a controller to abort.
    if (this.stopping) {
      controller.abort(new Error('Worker stopping'));
    }
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
      total = plan.frames * 2;
      controller.signal.throwIfAborted();
      this.storage.mkdirSync(folder);
      stage = MediaOperationStatus.Rendering;
      await monitor();
      controller.signal.throwIfAborted();
      await this.renderer.reverse(original.entry.path!, path, plan, controller.signal, (value) => {
        frames = value;
      });
      const stat = await this.storage.stat(path);
      if (!stat.isFile() || stat.size === 0) {
        throw new Error('Missing reversed file');
      }
      checkStudioReverseOutput(plan, await this.media.probe(path, { countFrames: true }));
      const checksum = (await this.crypto.hashFile(path, 'sha256')).toString('hex');
      // The preview reads the checked master; source reversal and timeline effects are not repeated.
      controller.signal.throwIfAborted();
      await this.renderer.preview(path, previewPath, plan, controller.signal, (value) => {
        frames = plan.frames + value;
      });
      // Stop rendering progress before entering validation; a late report cannot move its stage back.
      clearInterval(heartbeat);
      await writing;
      controller.signal.throwIfAborted();
      if (!(await this.operations.beginValidation(operation.id, claimToken))) {
        throw new Error('Claim lost');
      }
      const previewStat = await this.storage.stat(previewPath);
      if (!previewStat.isFile() || previewStat.size === 0 || previewStat.size > 64 * 1024 * 1024) {
        throw new Error('Missing or oversized reverse preview');
      }
      const previewInfo = await this.media.probe(previewPath, { countFrames: true });
      checkStudioReversePreview(
        plan,
        previewInfo,
        await this.renderer.probeGeometry(previewPath, previewInfo.videoStreams[0]?.index ?? 0),
        await this.renderer.previewPackets(previewPath, controller.signal),
      );
      const previewChecksum = (await this.crypto.hashFile(previewPath, 'sha256')).toString('hex');
      const previewLineage = [`${StudioResourceKind.GeneratedIntermediate}:${generatedId}`, snapshot.sourceKey];

      const current = await this.source(auth, snapshot.projectId, snapshot.revision, snapshot.sourceKey, true);
      this.requireBinding(snapshot, current);
      await this.checkBytes(current.entry);
      const result = {
        kind: 'studio-source-reverse',
        // Private producer byte binding, retained with the immutable operation result.
        checksum,
        generatedId,
        sourceKey: snapshot.sourceKey,
        sourceRevision: snapshot.revision,
        sourceRevisionDigest: snapshot.digest,
        sourceLevel: true,
        requiresClipRelink: true,
        browserPreview: {
          generatedId: previewId,
          checksum: previewChecksum,
          derivedFrom: previewLineage,
          contentType: 'video/mp4',
          profile: 'h264-main-3.2-aac-lc-v1',
          duration: (plan.frames * plan.frameRate.den) / plan.frameRate.num,
          audio: plan.audioIndex === null ? null : { channels: plan.channels, sampleRate: plan.sampleRate },
          // The authenticated operation route rechecks source access and the exact bytes.
          delivery: 'authenticated',
        },
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
        await this.projects.registerGeneratedResource(
          {
            projectId: snapshot.projectId,
            ownerId: operation.ownerId,
            sourceRevision: snapshot.revision,
            id: previewId,
            producer: 'proxy',
            checksum: previewChecksum,
            path: previewPath,
            derivedFrom: previewLineage,
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
          declarations.every((entry) => entry.path !== path && entry.path !== previewPath)
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
    await this.studio.requireOwnedProject(auth, projectId, 'Only an active project owner may reverse its sources');
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
      imports: await this.projects.listImportDeclarations(projectId),
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
    return {
      entry,
      sourceEpochs: resolution.manifest.sourceEpochs?.filter(row => row.assetId === entry.id),
      digest: authorized.revision.digest,
      revisionId: authorized.revision.id,
      graph: authorized.envelope.graph,
    };
  }

  private requireBinding(snapshot: ReverseSnapshot, resolved: { entry: StudioAuthorizedEntry; digest: string; sourceEpochs?: SourceEpoch[] }) {
    const epochChanged = snapshot.sourceEpochs ? !isDeepStrictEqual(snapshot.sourceEpochs, resolved.sourceEpochs) : resolved.sourceEpochs?.some(row => row.epoch !== '0');
    if (epochChanged || resolved.digest !== snapshot.digest || resolved.entry.checksum !== snapshot.checksum) {
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
