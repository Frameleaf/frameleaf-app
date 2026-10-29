import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { SpeechRevisionDto, SpeechSearchDto, SpeechSettingsUpdateDto, SpeechStatusDto } from 'src/dtos/speech.dto.js';
import {
  FrameleafWorker,
  MediaOperationKind,
  MediaOperationStatus,
  MlDestinationKind,
  MlWorkload,
  StorageFolder,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  MachineLearningRepository,
  TranscriptionUnavailableError,
} from 'src/repositories/machine-learning.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SpeechRepository, speechDefaults } from 'src/repositories/speech.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioTranscriptionRepository } from 'src/repositories/studio-transcription.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { speechChunks, speechQuery, speechWords } from 'src/utils/speech.js';

const LEASE_MS = 120_000;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
export const speechFolder = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), 'speech-index');

@Injectable()
export class SpeechService {
  private workerId = `speech-${randomUUID()}`;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private abort?: AbortController;
  private stopping = false;
  private cleanupCursor?: string;
  constructor(
    private repository: SpeechRepository,
    private operations: MediaOperationRepository,
    private media: MediaRepository,
    private storage: StorageRepository,
    private audio: StudioTranscriptionRepository,
    private machineLearning: MachineLearningRepository,
    private mlDestinations: MlDestinationRepository,
    private logger: LoggingRepository,
    private websocket: WebsocketRepository,
  ) {
    this.logger.setContext(SpeechService.name);
  }

  private changed(ownerId: string) {
    this.websocket.clientSend('on_speech_index_change', ownerId);
  }

  @OnEvent({ name: 'AssetChanged' })
  async onAssetChanged({ assetId }: { assetId: string }) {
    const owner = await this.repository.assetOwner(assetId);
    if (owner) {
      await this.repository.wake(owner.ownerId);
      this.changed(owner.ownerId);
    }
  }

  @OnEvent({ name: 'AssetLocked' })
  async onAssetLocked({ assetIds }: { assetIds: string[] }) {
    for (const assetId of assetIds) await this.onAssetChanged({ assetId });
  }

  private async ownerChanged(ownerId: string) {
    await this.repository.wake(ownerId);
    this.changed(ownerId);
  }

  @OnEvent({ name: 'AssetTrashAll' })
  async onAssetTrashAll({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'AssetDeleteAll' })
  async onAssetDeleteAll({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'AssetRestoreAll' })
  async onAssetRestoreAll({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'AssetMetadataExtracted' })
  async onAssetMetadataExtracted({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'AssetTrash' })
  async onAssetTrash({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'AssetDelete' })
  async onAssetDelete({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'AssetHide' })
  async onAssetHide({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'AssetShow' })
  async onAssetShow({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'PersonChanged' })
  async onPersonChanged({ ownerId }: { ownerId: string }) {
    await this.ownerChanged(ownerId);
  }

  @OnEvent({ name: 'AssetLocalEffects' })
  async onAssetLocalEffects({ ownerId }: { ownerId: string }) {
    await this.ownerChanged(ownerId);
  }

  @OnEvent({ name: 'AlbumUserRemove' })
  async onAlbumUserRemove({ userId }: { userId: string }) {
    await this.ownerChanged(userId);
  }

  @OnEvent({ name: 'AlbumUpdate' })
  async onAlbumUpdate({ userIds, recipientIds }: { userIds: string[]; recipientIds: string[] }) {
    for (const ownerId of new Set([...userIds, ...recipientIds])) await this.ownerChanged(ownerId);
  }

  private owner(auth: AuthDto) {
    if (auth.sharedLink) throw new NotFoundException('Speech indexing not found');
    return auth.user.id;
  }

  private async admit(destinationId: string, jobId: string | null = null) {
    const destination = await this.mlDestinations.getById(destinationId);
    if (!destination || ![MlDestinationKind.Local, MlDestinationKind.Lan].includes(destination.kind)) {
      throw new TranscriptionUnavailableError('Speech requires this server or a home-network worker');
    }
    return selectMlDestination(
      { mlDestinationRepository: this.mlDestinations, machineLearningRepository: this.machineLearning },
      {
        workload: MlWorkload.StudioAi,
        destinationId,
        jobId,
        jobName: 'speech-transcription',
        studioFeature: 'captions',
      },
    );
  }

  async status(auth: AuthDto): Promise<SpeechStatusDto> {
    const ownerId = this.owner(auth);
    let settings = await this.repository.settings(ownerId);
    let workerAvailable = false;
    if (settings?.destinationId) {
      let identity: Awaited<ReturnType<MachineLearningRepository['transcriptionIdentity']>> | undefined;
      try {
        identity = await this.machineLearning.transcriptionIdentity(await this.admit(settings.destinationId));
      } catch {
        /* A missing worker is an explicit state; existing transcripts remain private and readable. */
      }
      workerAvailable = !!identity;
      if (identity) {
        if (settings.enabled && settings.modelFingerprint !== identity.fingerprint) {
          await this.repository.setModel(ownerId, settings.generation, identity.fingerprint);
          this.changed(ownerId);
        }
        settings = await this.repository.settings(ownerId);
      }
    }
    const counts = await this.repository.status(ownerId);
    const config = settings ?? speechDefaults;
    return {
      enabled: config.enabled,
      scope: config.scope,
      albumIds: config.albumIds,
      destinationId: config.destinationId,
      generation: settings?.generation ?? null,
      ...counts,
      workerAvailable,
      error: settings?.enabled && !workerAvailable ? 'unavailable' : counts.failed ? 'failed' : null,
    };
  }

  async configure(auth: AuthDto, dto: SpeechSettingsUpdateDto) {
    const ownerId = this.owner(auth);
    if (dto.enabled && dto.destinationId) {
      const destination = await this.mlDestinations.getById(dto.destinationId);
      if (!destination || ![MlDestinationKind.Local, MlDestinationKind.Lan].includes(destination.kind)) {
        throw new BadRequestException('Choose this server or a home-network worker');
      }
    }
    await this.repository.configure(ownerId, dto);
    this.changed(ownerId);
    return this.status(auth);
  }

  async purge(auth: AuthDto, dto: SpeechRevisionDto) {
    const ownerId = this.owner(auth);
    await this.repository.configure(ownerId, dto, true);
    this.changed(ownerId);
    return this.status(auth);
  }

  async retry(auth: AuthDto, dto: SpeechRevisionDto) {
    await this.repository.retry(this.owner(auth), dto.expectedGeneration);
    this.changed(auth.user.id);
    return this.status(auth);
  }

  async search(auth: AuthDto, dto: SpeechSearchDto) {
    this.owner(auth);
    let clauses;
    try {
      clauses = speechQuery(dto.query);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    await this.status(auth);
    return this.repository.search(auth, dto, clauses);
  }

  @OnEvent({ name: 'AppBootstrap', workers: [FrameleafWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.timer ??= setInterval(() => this.tick(), 5000);
    this.tick();
  }

  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.abort?.abort();
    await this.active;
  }

  tick() {
    if (this.active || this.stopping) return;
    this.active = this.drain()
      .catch(() => this.logger.warn('Speech indexing is waiting for its worker'))
      .finally(() => {
        this.active = undefined;
      });
  }

  async drain() {
    await this.cleanupFolders();
    for (const settings of await this.repository.due()) {
      try {
        const identity = await this.machineLearning.transcriptionIdentity(await this.admit(settings.destinationId!));
        if (settings.modelFingerprint !== identity.fingerprint) {
          await this.repository.setModel(settings.ownerId, settings.generation, identity.fingerprint);
          this.changed(settings.ownerId);
        }
        await this.repository.reconcile(settings.ownerId);
      } catch {
        // Let other accounts enter the bounded scheduler page while this worker is unavailable.
        await this.repository.defer(settings.ownerId, settings.generation);
      }
    }
    const job = await this.operations.claimNext({
      kinds: [MediaOperationKind.SpeechTranscription],
      workerId: this.workerId,
      leaseMs: LEASE_MS,
    });
    if (job) await this.run(job.operation, job.claimToken);
    await this.repository.cleanup();
  }

  private async cleanupFolders() {
    const owners = await this.repository.owners(this.cleanupCursor);
    for (const { ownerId } of owners) {
      if (!UUID.test(ownerId)) continue;
      const root = speechFolder(ownerId);
      const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
        const operation = await this.operations.getForWorker(entry.name);
        if (
          operation?.ownerId === ownerId &&
          operation.claimExpiresAt &&
          new Date(operation.claimExpiresAt).getTime() + 30_000 > Date.now()
        )
          continue;
        await this.storage.unlinkDir(join(root, entry.name), { recursive: true, force: true });
      }
    }
    this.cleanupCursor = owners.length === 50 ? owners.at(-1)!.ownerId : undefined;
  }

  async run(operation: MediaOperation, claimToken: string) {
    if ([operation.id, operation.ownerId, claimToken].some((value) => !UUID.test(value))) return;
    const folder = join(speechFolder(operation.ownerId), operation.id, claimToken);
    const controller = new AbortController();
    this.abort = controller;
    if (this.stopping) controller.abort();
    let heartbeatPending: Promise<void> | undefined;
    let progressPending = Promise.resolve();
    const check = async () => {
      if (
        !(await this.operations.heartbeat(operation.id, claimToken, LEASE_MS)) ||
        !(await this.repository.source(operation, claimToken))
      ) {
        throw new Error('Speech source or claim was revoked');
      }
      controller.signal.throwIfAborted();
    };
    const heartbeat = setInterval(() => {
      if (heartbeatPending) return;
      heartbeatPending = check()
        .catch(() => controller.abort())
        .finally(() => {
          heartbeatPending = undefined;
        });
    }, 5000);
    try {
      await check();
      const source = (await this.repository.source(operation, claimToken))!;
      const selection = await this.admit(String(operation.snapshot.destinationId), operation.id);
      const identity = await this.machineLearning.transcriptionIdentity(selection);
      if (identity.fingerprint !== operation.snapshot.modelFingerprint) throw new Error('Speech model changed');
      const info = await this.media.probe(source.originalPath, { signal: controller.signal, countFrames: false });
      const durationMs = Math.ceil(info.format.duration * 1000);
      const checkpoint = await this.repository.checkpoint(operation.id);
      let index = checkpoint?.nextChunk ?? 0;
      const chunks = info.audioStreams.length > 0 ? speechChunks(durationMs, index) : [];
      let language = checkpoint?.language ?? null;
      this.storage.mkdirSync(folder);
      // A reclaimed operation owns a new claim directory; old claims cannot publish or resume it.
      const parent = join(speechFolder(operation.ownerId), operation.id);
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && UUID.test(entry.name) && entry.name !== claimToken) {
          await this.storage.unlinkDir(join(parent, entry.name), { recursive: true, force: true });
        }
      }
      for (const chunk of chunks) {
        await check();
        const wav = join(folder, 'audio.wav');
        await this.audio.extractAudio(
          source.originalPath,
          wav,
          {
            startSeconds: String(chunk.startMs / 1000),
            durationSeconds: String((chunk.endMs - chunk.startMs) / 1000),
          },
          controller.signal,
        );
        await check();
        const transcript = await this.machineLearning.transcribe(
          selection,
          wav,
          { language: null },
          controller.signal,
          (segment) => {
            const processed = Math.min(durationMs, chunk.startMs + segment.end * 1000);
            progressPending = progressPending
              .then(async () => {
                await this.operations.reportProgress(operation.id, claimToken, {
                  status: MediaOperationStatus.Rendering,
                  processedUnits: Math.round(processed),
                  totalUnits: durationMs,
                  progress: durationMs ? (processed / durationMs) * 95 : 0,
                });
              })
              .catch(() => controller.abort());
          },
        );
        await progressPending;
        controller.signal.throwIfAborted();
        if (transcript.info.fingerprint !== identity.fingerprint || transcript.info.model !== identity.model)
          throw new Error('Speech model changed during transcription');
        language ??= transcript.info.language;
        const words = speechWords(transcript.segments, chunk);
        if (!(await this.repository.saveChunk(operation, claimToken, index, words, identity.model, language)))
          throw new Error('Speech scope changed');
        await this.storage.unlinkDir(wav, { force: true });
        index++;
      }
      await check();
      const hash = createHash(source.checksum.length === 20 ? 'sha1' : 'sha256');
      for await (const bytes of createReadStream(source.originalPath, { signal: controller.signal }))
        hash.update(bytes);
      if (!hash.digest().equals(source.checksum)) throw new Error('Speech source checksum changed');
      const finalIdentity = await this.machineLearning.transcriptionIdentity(
        await this.admit(String(operation.snapshot.destinationId), operation.id),
      );
      if (finalIdentity.fingerprint !== identity.fingerprint)
        throw new Error('Speech model changed before publication');
      await check();
      if (
        !(await this.operations.beginValidation(operation.id, claimToken, true)) ||
        !(await this.repository.publish(operation, claimToken, identity.model, language))
      ) {
        throw new Error('Speech publication was cancelled');
      }
      this.changed(operation.ownerId);
    } catch (error) {
      const held = await this.operations.getForWorker(operation.id);
      if (held?.claimToken === claimToken && held.status === MediaOperationStatus.Cancelling) {
        await this.operations.acknowledgeCancel(operation.id, claimToken, { released: true });
      } else if (error instanceof ServiceUnavailableException && held?.claimToken === claimToken) {
        await this.operations.requeue(operation.id, claimToken, {
          delayMs: 5000,
          returnAttempt: true,
          requireActiveClaim: true,
        });
      } else if (this.stopping && held?.claimToken === claimToken) {
        await this.operations.requeue(operation.id, claimToken, {
          delayMs: 0,
          returnAttempt: true,
          requireActiveClaim: true,
        });
      } else {
        await this.operations.fail(operation.id, claimToken, {
          errorCode: error instanceof TranscriptionUnavailableError ? 'speech_unavailable' : 'speech_failed',
          error: 'Speech indexing could not finish. Check the worker and retry from Spoken words settings.',
        });
      }
    } finally {
      clearInterval(heartbeat);
      await heartbeatPending;
      await progressPending;
      if (this.abort === controller) this.abort = undefined;
      await this.storage.unlinkDir(folder, { recursive: true, force: true }).catch(() => {});
    }
  }
}
