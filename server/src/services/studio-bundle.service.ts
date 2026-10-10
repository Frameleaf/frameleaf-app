import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { Transform, type Writable } from 'node:stream';
import { finished as streamFinished, pipeline } from 'node:stream/promises';
import { isDeepStrictEqual } from 'node:util';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { MediaOperationDto } from 'src/dtos/media-operation.dto.js';
import {
  StudioBundleExportCreateDto,
  StudioBundleImportCreateDto,
  StudioBundleOperationDto,
  StudioBundleSourceDto,
  StudioBundleUploadDto,
} from 'src/dtos/studio-bundle.dto.js';
import { ImmichWorker, MediaOperationKind, MediaOperationStatus, StorageFolder } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { ImmichReadStream, StorageRepository } from 'src/repositories/storage.repository.js';
import { StudioBundleUpload, StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import {
  STUDIO_BUNDLE_DOCUMENT_RESERVATION,
  STUDIO_BUNDLE_EXPORT_RESERVATION,
} from 'src/repositories/studio-storage-admission.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { mapOperation } from 'src/services/media-operation.service.js';
import { StudioProjectImportService, studioImportIncomingFolder } from 'src/services/studio-project-import.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { isLockedRow } from 'src/utils/locked.js';
import { mimeTypes } from 'src/utils/mime-types.js';
import {
  STUDIO_BUNDLE_DESTINATION,
  STUDIO_BUNDLE_EMBEDDABLE_KINDS,
  STUDIO_BUNDLE_EXPORT_TTL_HOURS,
  STUDIO_BUNDLE_KINDS,
  STUDIO_BUNDLE_MANIFEST_ENTRY,
  STUDIO_BUNDLE_MAX_ATTEMPTS,
  STUDIO_BUNDLE_MAX_BYTES,
  STUDIO_BUNDLE_MEDIA_PREFIX,
  STUDIO_BUNDLE_PROJECT_ENTRY,
  STUDIO_BUNDLE_UPLOAD_TTL_HOURS,
  StudioBundleArchiveError,
  StudioBundleExportResult,
  StudioBundleExportSnapshot,
  StudioBundleFileDigest,
  StudioBundleImportResult,
  StudioBundleImportSnapshot,
  StudioBundleManifest,
  StudioBundleMissingSource,
  StudioBundleSource,
  ZipByteSource,
  buildStudioBundleManifest,
  bundleMediaEntryName,
  checkStudioBundleManifest,
  checkStudioBundleProject,
  digestZipEntry,
  isBundleExportDownloadable,
  isStudioBundleImportAlias,
  parseBundleExportResult,
  parseBundleExportSnapshot,
  parseBundleImportResult,
  parseBundleImportSnapshot,
  planStudioBundleRelink,
  readZipDirectory,
  readZipEntry,
  relinkStudioGraph,
  selectStudioSequences,
  serializeStudioBundleProject,
  studioBundleFileName,
  studioBundleImportSources,
  studioBundleSourceKeys,
  studioChecksumSha256,
  studioSequenceSubsetProblem,
} from 'src/utils/studio-bundle.js';
import {
  STUDIO_LIFECYCLE_SWEEP_MS,
  StudioProjectEnvelope,
  checkStudioEnvelope,
  studioEnvelopeDigest,
} from 'src/utils/studio-project.js';
import {
  StudioDestination,
  StudioResourceKind,
  extractStudioResourceReferences,
  isStudioUuid,
  studioReferenceKey,
} from 'src/utils/studio-resources.js';

/** How often the worker looks for queued bundle jobs. */
export const STUDIO_BUNDLE_TICK_MS = 5000;
/** The claim lease. Extended with every progress write; a worker that stops writing loses the job. */
export const STUDIO_BUNDLE_LEASE_MS = 2 * 60_000;

/** The folder, under the owner's private exports, that holds bundle files and staging. */
const BUNDLE_FOLDER = 'studio-bundles';
/** Uploaded bundles waiting to be imported, beside the exports and just as private. */
const UPLOAD_FOLDER = 'studio-bundle-uploads';

/** Where an owner's bundle files live. Outside every served folder; reached only by owner-scoped routes. */
export const studioBundleFolder = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), BUNDLE_FOLDER);

/** Where multer writes an owner's uploaded bundle before it is validated. */
export const studioBundleUploadFolder = (ownerId: string) =>
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), UPLOAD_FOLDER);

/**
 * A failure of the whole job. It is retried once automatically (owner decision, September 22,
 * 2026), and every step below is safe to repeat: an export rewrites its own partial file, and an
 * import finds the project its first attempt created by the job id.
 */
class BundleJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Generated artifacts need a portable file/lineage contract before they can leave their project. */
const requirePortableSources = (graph: unknown): void => {
  if (
    extractStudioResourceReferences(graph).references.some(
      (reference) =>
        reference.kind === StudioResourceKind.GeneratedIntermediate ||
        (reference.kind === StudioResourceKind.Audio && reference.source === 'generated'),
    )
  ) {
    throw new BadRequestException('Bundles containing generated media are not supported yet');
  }
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);

const errorCode = (error: unknown) =>
  error instanceof BundleJobError || error instanceof StudioBundleArchiveError ? error.code : 'bundle_failed';

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const hoursFrom = (now: Date, hours: number) => new Date(now.getTime() + hours * 60 * 60 * 1000);

/** A synthetic graph naming each id at the key its kind is read from, for an FL-90 decision. */
const graphNaming = (items: ReadonlyArray<{ kind: StudioResourceKind; id: string }>) => ({
  sources: items.map((item) =>
    item.kind === StudioResourceKind.EditedMaster ? { editedMasterOf: item.id } : { assetId: item.id },
  ),
});

type RunningJob = { operation: MediaOperation; claimToken: string };

/**
 * Portable Studio project bundles (FL-91, `STU-204`), as durable media operations (FL-104).
 *
 * Export and import are `media_operation` rows claimed by this service on the microservices worker,
 * exactly like bulk work: nothing about a running bundle lives in a browser tab, and Activity shows
 * them beside renders. The rules it keeps:
 *
 * - **Access is decided through FL-90.** What an export may copy is resolved for the submitting
 *   session and frozen in the snapshot: media the account owns and may place in Studio, never
 *   shared media and never Locked media, whatever the worker itself could read. What an import may
 *   relink to is resolved for the importer, at submit and again when the job runs.
 * - **Originals are never overwritten.** An export only reads library files; an import only writes
 *   a new project. Embedded copies of library media are verified and reported, never written into
 *   the library.
 * - **Files kept with the project travel with it (FL-105).** An export copies the project's imports
 *   when media is asked for, and an import keeps each one with the new project under the same id,
 *   through the same checks as an upload: the type is read from the bytes again, nothing the bundle
 *   says about a file is believed, and a file that fails is left out and reported.
 * - **The graph stays opaque.** It leaves as the stored revision, byte for byte, and comes back with
 *   only its source ids relinked.
 * - **Retention is bounded.** An uploaded bundle is kept for {@link STUDIO_BUNDLE_UPLOAD_TTL_HOURS}
 *   hours, a finished export for {@link STUDIO_BUNDLE_EXPORT_TTL_HOURS}, and the sweep that removes
 *   them also purges trashed projects whose retention has run out.
 */
@Injectable()
export class StudioBundleService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private lastSweepAt = 0;
  private readonly workerId = `studio-bundle-${randomUUID()}`;
  /** Stands in for a session on the worker's auth; nothing on these paths reads it back. */
  private readonly sessionId = randomUUID();

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private projects: StudioProjectRepository,
    private storage: StorageRepository,
    private crypto: CryptoRepository,
    private assets: AssetRepository,
    private users: UserRepository,
    private resources: StudioResourceService,
    private studio: StudioProjectService,
    private imports: StudioProjectImportService,
  ) {
    this.logger.setContext(StudioBundleService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Export: submit and download                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Queue an export of the project's current revision. Owner only.
   *
   * The revision, its digest and the list of sources the bundle may carry copies of are fixed
   * here, for this session, through FL-90. A later save does not change what this job writes, and
   * the worker, which can reach more than the session could, never embeds anything else.
   */
  async createExport(auth: AuthDto, projectId: string, dto: StudioBundleExportCreateDto): Promise<MediaOperationDto> {
    this.requireInteractive(auth);

    if (dto.requestKey) {
      const existing = await this.operations.getByRequestKey(
        auth.user.id,
        MediaOperationKind.StudioBundleExport,
        dto.requestKey,
      );
      if (existing) {
        // A key names one request, including which sequences and media travel in the bundle.
        const snapshot = existing.snapshot as Partial<StudioBundleExportSnapshot> | null;
        const requestedSequenceIds = dto.sequenceIds ? [...new Set(dto.sequenceIds)].sort() : null;
        const previousSequenceIds = snapshot?.requestedSequenceIds ?? snapshot?.sequenceIds;
        let sameSelection = isDeepStrictEqual(
          previousSequenceIds ? [...new Set(previousSequenceIds)].sort() : null,
          requestedSequenceIds,
        );
        if (
          !sameSelection &&
          snapshot &&
          snapshot.requestedSequenceIds === undefined &&
          snapshot.sequenceIds === null &&
          snapshot.projectId === projectId &&
          requestedSequenceIds &&
          typeof snapshot.revision === 'number'
        ) {
          // Older jobs kept no record of an explicit choice that covered every sequence.
          const revision = await this.projects.getRevision(projectId, snapshot.revision);
          if (revision && revision.digest === snapshot.digest) {
            const checked = checkStudioEnvelope(revision.envelope);
            const selected = checked.ok ? selectStudioSequences(checked.envelope.graph, requestedSequenceIds) : null;
            sameSelection =
              checked.ok &&
              studioEnvelopeDigest(checked.envelope) === snapshot.digest &&
              selected?.ok === true &&
              selected.sequenceIds === null;
          }
        }
        if (
          !snapshot ||
          snapshot.projectId !== projectId ||
          snapshot.includeMedia !== (dto.includeMedia ?? false) ||
          !sameSelection
        ) {
          throw new ConflictException('This request key was already used for another export');
        }
        return mapOperation(existing);
      }
    }

    // FL-280: refuse a caller who is not the owner before resolving any source for them
    await this.studio.requireOwnedProject(auth, projectId, 'Only the owner can export a Studio project');
    const authorized = await this.studio.authorizeRevision(auth, { projectId, destination: StudioDestination.Local });
    if (authorized.access !== 'owner') {
      throw new ForbiddenException('Only the owner can export a Studio project');
    }

    // A subset is checked against the revision being exported, so an unknown sequence is refused
    // now rather than failing the job, and only the media the kept sequences use may be copied.
    let sequenceIds: string[] | null = null;
    let keptKeys: Set<string> | null = null;
    let exportGraph = authorized.envelope.graph;
    if (dto.sequenceIds && dto.sequenceIds.length > 0) {
      const selected = selectStudioSequences(authorized.envelope.graph, dto.sequenceIds);
      if (!selected.ok) {
        throw new BadRequestException(`This project has no sequence ${selected.unknown.join(', ').slice(0, 200)}`);
      }
      exportGraph = selected.graph;
      if (selected.sequenceIds) {
        sequenceIds = [...new Set(dto.sequenceIds)];
        keptKeys = new Set(studioBundleSourceKeys(selected.graph).map((key) => key.key));
      }
    }

    requirePortableSources(exportGraph);

    const embed = new Map<string, { key: string; kind: StudioResourceKind; id: string }>();
    if (dto.includeMedia) {
      for (const entry of authorized.manifest.entries) {
        if (
          (!keptKeys || keptKeys.has(entry.key)) &&
          (STUDIO_BUNDLE_EMBEDDABLE_KINDS as readonly StudioResourceKind[]).includes(entry.kind) &&
          entry.sourceAccess === 'owner' &&
          entry.path &&
          !embed.has(entry.key)
        ) {
          embed.set(entry.key, { key: entry.key, kind: entry.kind, id: entry.id });
        }
      }
    }

    // FL-105: the files kept with the project travel with it. A whole project names all of them, a
    // subset the ones its sequences place (a clip names a kept file by id, under whatever key).
    const placed = sequenceIds
      ? new Set(extractStudioResourceReferences(exportGraph).references.map((reference) => reference.id))
      : null;
    const importFiles = (await this.projects.listImportDeclarations(authorized.project.id)).filter(
      (item) => !placed || placed.has(item.id),
    );
    const imports = importFiles.map((item) => item.id);
    let mediaBytes = dto.includeMedia ? importFiles.reduce((total, item) => total + item.sizeBytes, 0) : 0;
    for (const item of embed.values()) {
      const path = authorized.manifest.entries.find((entry) => entry.key === item.key)?.path;
      let bytes = STUDIO_BUNDLE_MAX_BYTES;
      try {
        if (path) bytes = (await this.storage.stat(path)).size;
      } catch {
        // Unmeasurable sources reserve the maximum; the worker revalidates them before reading.
      }
      mediaBytes += bytes;
    }
    // JSON staging plus the ZIP's media, documents, directory and compression overhead.
    const storageReservationBytes =
      STUDIO_BUNDLE_DOCUMENT_RESERVATION +
      Math.min(
        STUDIO_BUNDLE_MAX_BYTES,
        Math.ceil(mediaBytes * 1.001) + STUDIO_BUNDLE_DOCUMENT_RESERVATION + 9 * 1024 ** 2,
      );

    const snapshot: StudioBundleExportSnapshot = {
      kind: 'studio-bundle-export',
      projectId: authorized.project.id,
      revision: authorized.revision.revision,
      digest: authorized.revision.digest,
      includeMedia: dto.includeMedia === true,
      embed: embed.values().toArray(),
      imports,
      sequenceIds,
      requestedSequenceIds: dto.sequenceIds ? [...new Set(dto.sequenceIds)].sort() : null,
      requestKey: dto.requestKey ?? null,
    };

    const created = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.StudioBundleExport,
      destination: STUDIO_BUNDLE_DESTINATION,
      destinationDetail: null,
      label: authorized.project.name,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: authorized.project.id,
      revisionId: authorized.revision.id,
      snapshot: snapshot as unknown as Record<string, unknown>,
      settings: { includeMedia: snapshot.includeMedia, sequenceIds, storageReservationBytes },
      estimate: null,
      totalUnits: null,
      maxAttempts: STUDIO_BUNDLE_MAX_ATTEMPTS,
    });

    this.logger.log(`Studio bundle export queued as media operation ${created.id} for project ${projectId}`);
    return mapOperation(created);
  }

  /**
   * Stream a finished export. Looked up by owner, so this is the only way the file is reachable,
   * and an expired or swept file is gone rather than served late.
   */
  async downloadExport(auth: AuthDto, operationId: string): Promise<ImmichReadStream> {
    const operation = await this.findOwnedBundle(auth, operationId);
    await this.requireCarriedItemsVisible(auth, operation);
    if (operation.kind !== MediaOperationKind.StudioBundleExport) {
      throw new NotFoundException('Studio bundle not found');
    }
    const result = parseBundleExportResult(operation.result);
    if (operation.status !== MediaOperationStatus.Completed || !result) {
      throw new BadRequestException('This bundle is not ready yet');
    }
    if (!isBundleExportDownloadable(result)) {
      throw new NotFoundException('This bundle has expired; export the project again');
    }

    const stream = await this.storage.createReadStream(result.path, 'application/zip');
    return {
      ...stream,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}`,
    };
  }

  /** One bundle job with what it produced, for the project library and Activity. */
  async getOperation(auth: AuthDto, operationId: string): Promise<StudioBundleOperationDto> {
    const operation = await this.findOwnedBundle(auth, operationId);
    await this.requireCarriedItemsVisible(auth, operation);
    const isExport = operation.kind === MediaOperationKind.StudioBundleExport;
    const exported = isExport ? parseBundleExportResult(operation.result) : null;
    const completed = operation.status === MediaOperationStatus.Completed;
    const imported = !isExport && completed ? parseBundleImportResult(operation.result) : null;

    return {
      operationId: operation.id,
      kind: operation.kind as MediaOperationKind,
      status: operation.status as MediaOperationStatus,
      progress: operation.progress,
      attempt: operation.attempt,
      maxAttempts: operation.maxAttempts,
      // The same retry state Activity reads (FL-104), so the project library's dialog can say a
      // job is waiting for its automatic retry instead of calling it freshly queued.
      autoRetries: operation.autoRetries ?? 0,
      retryAt: asIso(operation.retryAt),
      error: operation.error,
      errorCode: operation.errorCode,
      projectId: isExport ? operation.projectId : (imported?.projectId ?? null),
      export:
        exported && completed
          ? {
              fileName: exported.fileName,
              sizeBytes: String(exported.sizeBytes),
              digest: exported.digest,
              expiresAt: exported.expiresAt,
              downloadable: isBundleExportDownloadable(exported),
              embedded: exported.embedded,
              referenced: exported.referenced,
            }
          : null,
      import: imported,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Import: upload, review and submit                                    */
  /* ------------------------------------------------------------------ */

  /** Reserve before the HTTP body is written; an interrupted upload stays charged until cleanup. */
  async reserveUpload(auth: AuthDto, bytes: number): Promise<StudioBundleUpload> {
    this.requireInteractive(auth);
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > STUDIO_BUNDLE_MAX_BYTES)
      throw new PayloadTooLargeException('Invalid Studio bundle upload size');
    return this.projects.createUpload({
      ownerId: auth.user.id,
      path: join(studioBundleUploadFolder(auth.user.id), `${randomUUID()}.zip`),
      sizeBytes: bytes,
      digest: '',
      originalFileName: '',
      manifest: {},
      expiresAt: hoursFrom(new Date(), STUDIO_BUNDLE_UPLOAD_TTL_HOURS),
    });
  }

  async abortUpload(auth: AuthDto, id: string): Promise<void> {
    const upload = await this.projects.getUpload(id, auth.user.id);
    if (!upload) return;
    await this.storage.unlink(upload.path);
    await this.projects.deleteUpload(id, auth.user.id);
  }

  /** Validate the archive before converting its temporary reservation into a retained upload. */
  async registerUpload(
    auth: AuthDto,
    file: Express.Multer.File | undefined,
    reservationId?: string,
  ): Promise<StudioBundleUploadDto> {
    this.requireInteractive(auth);
    if (!file?.path) {
      throw new BadRequestException('Choose a Studio bundle to upload');
    }

    let manifest: StudioBundleManifest;
    let digest: string;
    try {
      if (file.size > STUDIO_BUNDLE_MAX_BYTES) {
        throw new StudioBundleArchiveError('bundle_too_large', 'The file is larger than a bundle may be');
      }
      digest = (await this.crypto.hashFile(file.path, 'sha256')).toString('hex');
      manifest = await this.withArchive(file.path, async (source) => (await this.readBundle(source)).manifest);
    } catch (error) {
      await this.storage.unlink(file.path);
      if (error instanceof StudioBundleArchiveError) {
        throw new BadRequestException({ message: error.message, code: error.code });
      }
      throw error;
    }

    let upload: StudioBundleUpload;
    try {
      if (!reservationId) throw new BadRequestException('Studio upload reservation required');
      upload = await this.projects.finalizeUpload(reservationId, {
        ownerId: auth.user.id,
        path: file.path,
        sizeBytes: file.size,
        digest,
        originalFileName: basename(file.originalname || 'bundle.zip').slice(0, 255),
        manifest: manifest as unknown as Record<string, unknown>,
        expiresAt: hoursFrom(new Date(), STUDIO_BUNDLE_UPLOAD_TTL_HOURS),
      });
    } catch (error) {
      // No row, no way for the sweep to find the file: remove it now.
      await this.storage.unlink(file.path);
      throw error;
    }

    this.logger.log(`Studio bundle upload ${upload.id} registered (${manifest.sources.length} sources)`);
    return this.mapUpload(auth, upload, manifest);
  }

  async getUpload(auth: AuthDto, id: string): Promise<StudioBundleUploadDto> {
    const upload = await this.findUpload(auth, id);
    return this.mapUpload(auth, upload, this.storedManifest(upload));
  }

  /** Discard an upload now rather than at its expiry. */
  async deleteUpload(auth: AuthDto, id: string): Promise<void> {
    this.requireInteractive(auth);
    const removed = await this.projects.getUpload(id, auth.user.id);
    if (!removed) {
      throw new NotFoundException('Studio bundle upload not found');
    }
    await this.storage.unlink(removed.path);
    await this.projects.deleteUpload(id, auth.user.id);
  }

  /**
   * Queue an import of an uploaded bundle into a new project of the importer's.
   *
   * Every relink target is checked now through FL-90 for this session, so a person hears at once
   * that a chosen item cannot be used; the job checks again when it runs, because access can
   * change in between.
   */
  async createImport(auth: AuthDto, dto: StudioBundleImportCreateDto): Promise<MediaOperationDto> {
    this.requireInteractive(auth);

    if (dto.requestKey) {
      const existing = await this.operations.getByRequestKey(
        auth.user.id,
        MediaOperationKind.StudioBundleImport,
        dto.requestKey,
      );
      if (existing) {
        const snapshot = existing.snapshot as Partial<StudioBundleImportSnapshot> | null;
        if (
          !snapshot ||
          snapshot.uploadId !== dto.uploadId ||
          (snapshot.name ?? null) !== (dto.name ?? null) ||
          !isDeepStrictEqual(snapshot.mapping ?? {}, dto.mapping ?? {})
        ) {
          throw new ConflictException('This request key was already used for another import');
        }
        return mapOperation(existing);
      }
    }

    const upload = await this.findUpload(auth, dto.uploadId);
    if (new Date(upload.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('This upload has expired; upload the bundle again');
    }
    const manifest = this.storedManifest(upload);
    const byKey = new Map(manifest.sources.map((source) => [source.key, source]));

    const mapping: Record<string, string> = {};
    for (const [key, assetId] of Object.entries(dto.mapping ?? {})) {
      const source = byKey.get(key);
      if (!source) {
        throw new BadRequestException(`The bundle has no source ${key.slice(0, 80)}`);
      }
      if (source.kind === StudioResourceKind.ProjectImport) {
        throw new BadRequestException('A file kept with the project travels with it and cannot be replaced');
      }
      mapping[key] = assetId;
    }

    const targets = Object.entries(mapping)
      .filter(([key, assetId]) => byKey.get(key)?.id !== assetId)
      .map(([key, assetId]) => ({ kind: byKey.get(key)!.kind, id: assetId }));
    const allowed = await this.authorizedKeys(auth, upload.id, targets);
    const refused = targets.filter((target) => !allowed.has(studioReferenceKey(target)));
    if (refused.length > 0) {
      throw new BadRequestException(
        `${refused.length} of the items you chose cannot be used in Studio; choose others or leave them missing`,
      );
    }

    const snapshot: StudioBundleImportSnapshot = {
      kind: 'studio-bundle-import',
      uploadId: upload.id,
      digest: upload.digest,
      name: dto.name ?? null,
      mapping,
      requestKey: dto.requestKey ?? null,
    };

    const created = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.StudioBundleImport,
      destination: STUDIO_BUNDLE_DESTINATION,
      destinationDetail: null,
      label: dto.name ?? manifest.project.name,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: snapshot as unknown as Record<string, unknown>,
      settings: {},
      estimate: null,
      totalUnits: null,
      maxAttempts: STUDIO_BUNDLE_MAX_ATTEMPTS,
    });

    this.logger.log(`Studio bundle import queued as media operation ${created.id} from upload ${upload.id}`);
    return mapOperation(created);
  }

  /* ------------------------------------------------------------------ */
  /* The worker                                                           */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), STUDIO_BUNDLE_TICK_MS);
    this.tick();
  }

  /** Stop taking work. A job in hand keeps its claim; the lease expiring hands it to the next worker. */
  @OnEvent({ name: 'AppShutdown' })
  async onShutdown() {
    this.stopping = true;
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = undefined;
    }
    await this.active;
  }

  /** Never overlaps itself: a tick that finds work in hand does nothing. */
  tick() {
    if (this.active || this.stopping) {
      return;
    }

    this.active = this.drain()
      .catch((error) => this.logger.warn(`Studio bundle worker failed: ${errorMessage(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  /**
   * Work through the queue until it is empty or we are stopping.
   *
   * Lapsed claims are not recovered here: `MediaOperationSweepService` recovers every kind of media
   * operation in one pass, bundle jobs with the rest, so a lapsed claim is judged once (FL-104).
   */
  async drain(): Promise<void> {
    await this.sweep();

    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: STUDIO_BUNDLE_KINDS,
        workerId: this.workerId,
        leaseMs: STUDIO_BUNDLE_LEASE_MS,
      });
      if (!claim) {
        return;
      }
      await this.run(claim);
    }
  }

  /**
   * Run one claimed job. A failure goes through the one automatic retry every media operation gets
   * (`MediaOperationRepository.fail`, FL-104): the first puts the job back in the queue to run again
   * from the start after the retry delay, the second is the job's answer. Both halves are
   * idempotent, so a retry never applies anything twice: a partial export is discarded before the
   * retry, and an import finds the project its first attempt created by the job id.
   */
  async run(job: RunningJob): Promise<void> {
    const { operation, claimToken } = job;
    try {
      await (operation.kind === MediaOperationKind.StudioBundleExport ? this.runExport(job) : this.runImport(job));
    } catch (error) {
      const failure = { error: errorMessage(error), errorCode: errorCode(error) };
      const outcome = await this.operations.fail(operation.id, claimToken, failure);
      // Only while the failure was still ours to report: a lost claim means another worker may be
      // writing the same file now. The retry is held back by its delay, so this lands first.
      if (outcome !== false && operation.kind === MediaOperationKind.StudioBundleExport) {
        await this.discardPartial(operation);
      }
      if (outcome === 'retrying') {
        this.logger.warn(`Studio bundle job ${operation.id} failed and will be retried once: ${failure.error}`);
      } else if (outcome === 'failed') {
        this.logger.error(`Studio bundle job ${operation.id} failed: ${failure.error}`);
      } else {
        this.logger.warn(`Studio bundle job ${operation.id} failed after its claim was lost: ${failure.error}`);
      }
    }
  }

  /**
   * Bounded retention for everything Studio keeps on the side: trashed projects past their
   * deadline, uploads past their expiry and finished exports past theirs. Library media is never
   * part of any of it.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    if (now.getTime() - this.lastSweepAt < STUDIO_LIFECYCLE_SWEEP_MS) {
      return;
    }
    this.lastSweepAt = now.getTime();

    const purged = await this.projects.deletePurgeable(now);
    if (purged.length > 0) {
      this.logger.log(`Deleted ${purged.length} Studio projects whose time in the trash ran out`);
    }

    for (const upload of await this.projects.listExpiredUploads(now)) {
      await this.storage.unlink(upload.path);
      await this.projects.deleteUpload(upload.id, upload.ownerId);
    }
    for (const operation of await this.operations.listUnreleasedBundleExports()) {
      await this.discardPartial(operation);
      await this.operations.setFinishedResult(operation.id, { ...operation.result, storageReleased: true });
    }

    // FL-103 / FL-105: the files of projects deleted for good go with them.
    await this.imports.sweep(now);

    for (const operation of await this.operations.listExpiredBundleExports(now)) {
      const result = parseBundleExportResult(operation.result);
      if (result) {
        await this.storage.unlink(result.path);
      }
      await this.operations.setFinishedResult(operation.id, {
        ...operation.result,
        expiredAt: now.toISOString(),
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Export runner                                                        */
  /* ------------------------------------------------------------------ */

  private async runExport({ operation, claimToken }: RunningJob): Promise<void> {
    const snapshot = parseBundleExportSnapshot(operation.snapshot);

    const project = await this.projects.getById(snapshot.projectId);
    if (!project || project.ownerId !== operation.ownerId || project.deletedAt) {
      throw new BundleJobError('bundle_project_unavailable', 'The project is gone or in the trash');
    }
    const revision = await this.projects.getRevision(project.id, snapshot.revision);
    if (!revision || revision.digest !== snapshot.digest) {
      throw new BundleJobError('bundle_revision_unavailable', 'The version this export was made from is gone');
    }
    const checked = checkStudioEnvelope(revision.envelope);
    if (!checked.ok || studioEnvelopeDigest(checked.envelope) !== snapshot.digest) {
      throw new BundleJobError('bundle_revision_unavailable', 'The stored project does not match its digest');
    }
    // A partial bundle carries the chosen sequences and what they nest, cut from the frozen revision.
    let envelope = checked.envelope;
    let carried: string[] | null = null;
    if (snapshot.sequenceIds) {
      const selected = selectStudioSequences(envelope.graph, snapshot.sequenceIds);
      if (!selected.ok) {
        throw new BundleJobError(
          'bundle_sequences_unavailable',
          'The version this export was made from lacks a chosen sequence',
        );
      }
      envelope = { ...envelope, graph: selected.graph };
      carried = selected.sequenceIds;
    }

    requirePortableSources(envelope.graph);
    const owner = await this.authFor(operation.ownerId, { elevated: true });
    if (!owner) {
      throw new BundleJobError('bundle_owner_unavailable', 'The account that asked for this export no longer exists');
    }

    // The worker resolves as a background runner so it can read the files it was told to copy.
    // What it copies is still only what the submitting session was allowed to (`snapshot.embed`).
    const resolution = await this.resources.resolveProjectResources(owner, {
      projectId: project.id,
      ownerId: project.ownerId,
      revision: revision.revision,
      graph: envelope.graph,
      imports: await this.projects.listImportDeclarations(project.id),
      generated: await this.projects.listGeneratedResources(project.id),
      destination: StudioDestination.Local,
      backgroundRunner: true,
    });
    const entries = new Map(resolution.manifest.entries.map((entry) => [entry.key, entry]));
    const named = new Set(snapshot.imports);
    const keptFiles =
      named.size > 0 ? (await this.projects.listImports(project.id)).filter((item) => named.has(item.id)) : [];

    const keys = studioBundleSourceKeys(envelope.graph);
    // Only UUIDs can name a library row; any other identifier simply resolves to nothing.
    const ids = [...new Set(keys.map((key) => key.id).filter((id) => isStudioUuid(id)))];
    const rows = ids.length > 0 ? await this.assets.getByIds(ids) : [];
    const assets = new Map(rows.map((row) => [row.id, row]));
    const allowedEmbeds = new Set(snapshot.includeMedia ? snapshot.embed.map((item) => item.key) : []);

    const sources: StudioBundleSource[] = [];
    const embeds: Array<{ path: string; entryName: string }> = [];
    const media: Record<string, StudioBundleFileDigest> = {};
    let totalBytes = 0;

    for (const key of keys) {
      const entry = entries.get(key.key);
      const asset = assets.get(key.id);
      // Locked media leaves only as a file the owner's unlocked session asked this bundle to carry
      // (FL-195 follow-up: revealed, it behaves like any other item, and the bundle is then hidden from
      // every locked session). Otherwise it travels as a bare reference, not even by name.
      const revealed = allowedEmbeds.has(key.key) && asset?.ownerId === operation.ownerId;
      const known = entry && asset && (!isLockedRow(asset) || revealed) ? { entry, asset } : null;
      const fileName = known ? known.asset.originalFileName : null;
      const contentType = fileName ? mimeTypes.lookup(fileName) || null : null;
      const embedPath =
        known && known.entry.path && allowedEmbeds.has(key.key) && known.asset.ownerId === operation.ownerId
          ? known.entry.path
          : null;

      if (embedPath) {
        const { size } = await this.storage.stat(embedPath);
        totalBytes += size;
        if (totalBytes > STUDIO_BUNDLE_MAX_BYTES - 64 * 1024 * 1024) {
          throw new BundleJobError(
            'bundle_too_large',
            'The media in this project is too large for one bundle; export it without media',
          );
        }
        const sha256 = (await this.crypto.hashFile(embedPath, 'sha256')).toString('hex');
        // The entry is named after the file actually copied: an edited master is not in its
        // original's format, so its extension and type come from the copy, not the original name.
        const entryName = bundleMediaEntryName({ kind: key.kind, id: key.id, fileName: basename(embedPath) });
        const copiedType = mimeTypes.lookup(embedPath) || contentType;
        media[entryName] = { sha256, bytes: size };
        embeds.push({ path: embedPath, entryName });
        sources.push({
          ...key,
          mode: 'embedded',
          path: entryName,
          sha256,
          bytes: size,
          fileName,
          contentType: copiedType,
        });
      } else {
        sources.push({
          ...key,
          mode: 'reference',
          path: null,
          sha256: known ? studioChecksumSha256(known.asset.checksum) : null,
          bytes: null,
          fileName,
          contentType,
        });
      }
    }

    // FL-105: the files kept with the project, named by the submit. They are the owner's own and
    // only the owner exports, so each is copied when media was asked for; otherwise it is listed
    // with its digest so the import can say what is missing. The entry is named by the import id
    // and the extension the upload gave it, never by the name the file was uploaded with.
    for (const item of keptFiles) {
      const source = {
        key: studioReferenceKey({ kind: StudioResourceKind.ProjectImport, id: item.id }),
        kind: StudioResourceKind.ProjectImport,
        id: item.id,
        sha256: item.checksum,
        fileName: item.fileName,
        contentType: item.contentType,
      };
      if (!snapshot.includeMedia) {
        sources.push({ ...source, mode: 'reference', path: null, bytes: null });
        continue;
      }
      const { size } = await this.storage.stat(item.path);
      totalBytes += size;
      if (totalBytes > STUDIO_BUNDLE_MAX_BYTES - 64 * 1024 * 1024) {
        throw new BundleJobError(
          'bundle_too_large',
          'The media in this project is too large for one bundle; export it without media',
        );
      }
      const sha256 = (await this.crypto.hashFile(item.path, 'sha256')).toString('hex');
      if (sha256 !== item.checksum || size !== item.sizeBytes) {
        throw new BundleJobError('bundle_import_changed', 'A file kept with this project no longer matches its record');
      }
      const entryName = bundleMediaEntryName({ kind: source.kind, id: item.id, fileName: basename(item.path) });
      media[entryName] = { sha256, bytes: size };
      embeds.push({ path: item.path, entryName });
      sources.push({ ...source, mode: 'embedded', path: entryName, bytes: size });
    }

    const projectBytes = serializeStudioBundleProject(envelope);
    const manifest = buildStudioBundleManifest({
      createdAt: new Date(),
      producerVersion: serverVersion.toString(),
      name: project.name,
      revision: revision.revision,
      // A partial bundle's document is not the stored revision, so it is named by its own digest.
      digest: carried ? studioEnvelopeDigest(envelope) : snapshot.digest,
      sourceProjectId: project.id,
      sequenceIds: carried,
      engine: envelope.engine,
      engineRevision: envelope.engineRevision,
      project: projectBytes,
      sources,
      media,
    });
    const verified = checkStudioBundleManifest(JSON.parse(JSON.stringify(manifest)));
    if (!verified.ok) {
      throw new BundleJobError('bundle_manifest_invalid', verified.detail);
    }

    const total = totalBytes + projectBytes.length;
    if (!(await this.progress(operation.id, claimToken, { phase: 'writing' }, 0, total))) {
      return;
    }

    const folder = studioBundleFolder(operation.ownerId);
    const staging = join(folder, `${operation.id}.staging`);
    const target = join(folder, `${operation.id}.zip`);
    const partial = `${target}.partial`;
    this.storage.mkdirSync(staging);

    try {
      const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
      await this.storage.createOrOverwriteFile(join(staging, STUDIO_BUNDLE_MANIFEST_ENTRY), manifestBytes);
      await this.storage.createOrOverwriteFile(join(staging, STUDIO_BUNDLE_PROJECT_ENTRY), projectBytes);

      const zip = this.storage.createZipStream();
      const output = this.storage.createWriteStream(partial);
      let written = 0;
      const bounded = new Transform({
        transform(chunk, _encoding, callback) {
          written += chunk.length;
          callback(
            written >
              Number(operation.settings?.storageReservationBytes ?? STUDIO_BUNDLE_EXPORT_RESERVATION) -
                STUDIO_BUNDLE_DOCUMENT_RESERVATION
              ? new PayloadTooLargeException('Studio bundle exceeds its storage reservation')
              : null,
            chunk,
          );
        },
      });
      const finished = pipeline(zip.stream, bounded, output);
      // A throw below skips `await finished`; observe it now so it cannot go unhandled.
      void finished.catch(() => {});

      zip.addFile(join(staging, STUDIO_BUNDLE_MANIFEST_ENTRY), STUDIO_BUNDLE_MANIFEST_ENTRY);
      zip.addFile(join(staging, STUDIO_BUNDLE_PROJECT_ENTRY), STUDIO_BUNDLE_PROJECT_ENTRY);
      for (const embed of embeds) {
        zip.addFile(embed.path, embed.entryName);
      }
      await zip.finalize();
      await finished;
    } finally {
      await this.storage.unlinkDir(staging, { recursive: true, force: true });
    }

    // Read the written file back with the importer's own reader, so a bundle this server hands out
    // is one it would accept.
    await this.withArchive(partial, (source) => this.readBundle(source));

    if (!(await this.progress(operation.id, claimToken, { phase: 'verifying' }, total, total))) {
      await this.storage.unlink(partial);
      return;
    }

    await this.storage.rename(partial, target);
    const { size } = await this.storage.stat(target);
    const digest = (await this.crypto.hashFile(target, 'sha256')).toString('hex');

    const result: StudioBundleExportResult = {
      path: target,
      fileName: studioBundleFileName(project.name),
      sizeBytes: size,
      digest,
      expiresAt: hoursFrom(new Date(), STUDIO_BUNDLE_EXPORT_TTL_HOURS).toISOString(),
      embedded: embeds.length,
      referenced: sources.length - embeds.length,
    };

    if (!(await this.finish(operation.id, claimToken, result as unknown as Record<string, unknown>, total))) {
      // Cancelled at the last moment: the finished file goes with the job.
      await this.storage.unlink(target);
      return;
    }
    this.logger.log(
      `Studio bundle export ${operation.id} finished: ${embeds.length} embedded, ${result.referenced} referenced`,
    );
  }

  /**
   * Remove whatever an export that did not complete left behind. Only a completed export's file is
   * kept, and the sweep removes that one at its expiry, so nothing here outlives its job.
   */
  private async discardPartial(operation: MediaOperation) {
    const folder = studioBundleFolder(operation.ownerId);
    await this.storage.unlink(join(folder, `${operation.id}.zip.partial`));
    await this.storage.unlink(join(folder, `${operation.id}.zip`));
    await this.storage.unlinkDir(join(folder, `${operation.id}.staging`), { recursive: true, force: true });
  }

  /* ------------------------------------------------------------------ */
  /* Import runner                                                        */
  /* ------------------------------------------------------------------ */

  private async runImport({ operation, claimToken }: RunningJob): Promise<void> {
    const snapshot = parseBundleImportSnapshot(operation.snapshot);

    // A previous attempt may have committed the project before its job could finish. Its verified
    // result was saved before creation; use that result rather than re-admitting changed choices.
    const existing = await this.projects.getByImportOperation(operation.id);
    if (existing) {
      const result = operation.result as Partial<StudioBundleImportResult> | null;
      if (
        existing.ownerId !== operation.ownerId ||
        existing.importedFromDigest !== snapshot.digest ||
        !result ||
        typeof result.relinked !== 'number' ||
        typeof result.kept !== 'number' ||
        !Array.isArray(result.missing) ||
        typeof result.embeddedVerified !== 'number'
      ) {
        throw new BundleJobError('bundle_recovery_unavailable', 'The existing import cannot be recovered');
      }
      // The files kept with the project may not all have been kept before the first attempt
      // stopped. Keeping one twice answers with the stored file, so this is safe to repeat.
      const recovered = parseBundleImportResult(result);
      const retried = await this.projects.getUpload(snapshot.uploadId, operation.ownerId);
      const actor = retried ? await this.authFor(operation.ownerId, { elevated: false }) : null;
      if (
        retried &&
        actor &&
        (await this.crypto.hashFile(retried.path, 'sha256')).toString('hex') === snapshot.digest
      ) {
        const refused = await this.keepCarriedImports(actor, retried.path, this.storedManifest(retried), existing.id);
        const listed = new Set(recovered.missing.map((item) => item.key));
        recovered.missing.push(...refused.filter((item) => !listed.has(item.key)));
      }
      await this.projects.markUploadConsumed(snapshot.uploadId);
      await this.finish(operation.id, claimToken, { ...recovered, projectId: existing.id }, 1);
      return;
    }

    const upload = await this.projects.getUpload(snapshot.uploadId, operation.ownerId);
    if (!upload || new Date(upload.expiresAt).getTime() <= Date.now()) {
      throw new BundleJobError('bundle_upload_expired', 'The uploaded bundle has expired; upload it again');
    }
    const digest = (await this.crypto.hashFile(upload.path, 'sha256')).toString('hex');
    if (digest !== snapshot.digest || digest !== upload.digest) {
      throw new BundleJobError('bundle_upload_changed', 'The uploaded bundle changed after it was checked');
    }

    const owner = await this.authFor(operation.ownerId, { elevated: false });
    if (!owner) {
      throw new BundleJobError('bundle_owner_unavailable', 'The account that asked for this import no longer exists');
    }

    // Everything the manifest names is verified before anything is believed: the project document
    // by its two digests, and every embedded copy by its SHA-256, streamed.
    const verified = await this.withArchive(upload.path, (source) =>
      this.verifyBundle(source, operation.id, claimToken),
    );
    if (!verified) {
      return;
    }
    const { manifest, envelope, embeddedVerified } = verified;

    // Relink: the importer's choices, re-checked now, and originals that already resolve for them.
    // Files kept with the project are not relinked: they come with the bundle or are missing. A
    // library source that is one of them under its media id is left to the file's own source unless
    // the importer chose a stand-in for it.
    const carried = studioBundleImportSources(manifest.sources);
    const relinkable = manifest.sources.filter(
      (source) =>
        source.kind !== StudioResourceKind.ProjectImport &&
        (!isStudioBundleImportAlias(source, carried, envelope.graph) || source.key in snapshot.mapping),
    );
    const byKey = new Map(relinkable.map((source) => [source.key, source]));
    const chosen = Object.entries(snapshot.mapping).filter(
      ([key, assetId]) => byKey.has(key) && byKey.get(key)!.id !== assetId,
    );
    const stillAllowed = await this.authorizedKeys(
      owner,
      upload.id,
      chosen.map(([key, assetId]) => ({ kind: byKey.get(key)!.kind, id: assetId })),
    );
    if (
      chosen.some(
        ([key, assetId]) => !stillAllowed.has(studioReferenceKey({ kind: byKey.get(key)!.kind, id: assetId })),
      )
    ) {
      throw new BundleJobError('bundle_relink_unavailable', 'A chosen relink target is no longer available');
    }
    const mapping = Object.fromEntries(chosen);
    const resolvable = await this.authorizedKeys(owner, upload.id, relinkable);
    const plan = planStudioBundleRelink(relinkable, { mapping, resolvable });

    const relinkMap = new Map<string, string>();
    for (const step of plan) {
      if (step.outcome === 'mapped') {
        relinkMap.set(step.key, step.assetId);
      }
    }
    const relinked = relinkStudioGraph(envelope.graph, relinkMap);
    const next = checkStudioEnvelope({ ...envelope, graph: relinked.graph });
    if (!next.ok) {
      throw new BundleJobError('bundle_project_invalid', next.detail);
    }

    const missing: StudioBundleMissingSource[] = plan
      .filter((step) => step.outcome === 'missing')
      .map((step) => {
        const source = byKey.get(step.key)!;
        return {
          key: source.key,
          kind: source.kind,
          id: source.id,
          fileName: source.fileName,
          embedded: source.mode === 'embedded',
        };
      });
    // A kept file the bundle only names cannot be re-created here.
    for (const source of carried.values()) {
      if (source.mode !== 'embedded') {
        missing.push({ key: source.key, kind: source.kind, id: source.id, fileName: source.fileName, embedded: false });
      }
    }

    const prepared: StudioBundleImportResult = {
      projectId: null,
      relinked: relinkMap.size,
      kept: plan.filter((step) => step.outcome === 'kept').length,
      missing,
      embeddedVerified,
    };
    if (!(await this.progress(operation.id, claimToken, prepared as unknown as Record<string, unknown>, 1, 1))) {
      return;
    }

    const { project } = await this.projects.createWithRevision({
      ownerId: operation.ownerId,
      name: snapshot.name ?? manifest.project.name,
      importedFromDigest: upload.digest,
      importOperationId: operation.id,
      revision: {
        authorId: operation.ownerId,
        envelope: next.envelope as unknown as Record<string, unknown>,
        digest: studioEnvelopeDigest(next.envelope),
        graphBytes: next.graphBytes,
        summary: { counts: { 'project.importBundle': 1 }, total: 1 },
        requestKey: `bundle-import:${operation.id}`,
      },
    });
    // FL-105: keep the bundle's project files with the new project. One the checks refuse is left
    // out and reported; the project is still the importer's to open.
    const refused = await this.keepCarriedImports(owner, upload.path, manifest, project.id);
    await this.projects.markUploadConsumed(upload.id);

    const result: StudioBundleImportResult = {
      ...prepared,
      missing: [...missing, ...refused],
      projectId: project.id,
    };

    await this.finish(operation.id, claimToken, result as unknown as Record<string, unknown>, 1);
    this.logger.log(
      `Studio bundle import ${operation.id} created project ${project.id}: ` +
        `${result.relinked} relinked, ${result.kept} kept, ${missing.length} missing`,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Shared machinery                                                     */
  /* ------------------------------------------------------------------ */

  /** Open a bundle file for positional reads and always close it again. */
  private async withArchive<T>(path: string, read: (source: ZipByteSource) => Promise<T>): Promise<T> {
    const file = await this.storage.openForRandomRead(path);
    try {
      return await read({ size: file.size, read: file.read });
    } finally {
      await file.close();
    }
  }

  /**
   * Read and verify the two JSON documents, and check that the archive holds exactly the entries
   * the manifest lists at exactly the declared sizes. Media digests are the caller's to verify.
   */
  private async readBundle(source: ZipByteSource) {
    const directory = await readZipDirectory(source);

    const manifestEntry = directory.byName.get(STUDIO_BUNDLE_MANIFEST_ENTRY);
    if (!manifestEntry) {
      throw new StudioBundleArchiveError('bundle_manifest_missing', 'This file has no bundle manifest');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse((await readZipEntry(source, manifestEntry)).toString('utf8'));
    } catch (error) {
      if (error instanceof StudioBundleArchiveError) {
        throw error;
      }
      throw new StudioBundleArchiveError('bundle_manifest_invalid', 'The bundle manifest is not JSON');
    }
    const checked = checkStudioBundleManifest(parsed);
    if (!checked.ok) {
      throw new StudioBundleArchiveError('bundle_manifest_invalid', checked.detail);
    }
    const manifest = checked.manifest;

    for (const entry of directory.entries) {
      if (entry.name === STUDIO_BUNDLE_MANIFEST_ENTRY) {
        continue;
      }
      const declared = manifest.files[entry.name];
      if (!declared) {
        throw new StudioBundleArchiveError(
          'bundle_unexpected_entry',
          `${entry.name.slice(0, 80)} is not in the manifest`,
        );
      }
      if (declared.bytes !== entry.uncompressedSize) {
        throw new StudioBundleArchiveError(
          'bundle_size_mismatch',
          `${entry.name.slice(0, 80)} is not the size the manifest says`,
        );
      }
    }
    for (const name of Object.keys(manifest.files)) {
      if (!directory.byName.has(name)) {
        throw new StudioBundleArchiveError(
          'bundle_entry_missing',
          `${name.slice(0, 80)} is listed but not in the file`,
        );
      }
    }

    const projectBytes = await readZipEntry(source, directory.byName.get(STUDIO_BUNDLE_PROJECT_ENTRY)!);
    const project = checkStudioBundleProject(manifest, projectBytes);
    if (!project.ok) {
      throw new StudioBundleArchiveError('bundle_project_invalid', project.detail);
    }

    // A partial bundle holds exactly the sequences it names, and nothing in it points at one it
    // left behind, so the project an import creates never has a dangling compound clip.
    if (manifest.project.sequenceIds) {
      const problem = studioSequenceSubsetProblem(project.envelope.graph, manifest.project.sequenceIds);
      if (problem) {
        throw new StudioBundleArchiveError('bundle_project_invalid', problem);
      }
    }

    // Every media source the document names must be in the manifest, so the review the person
    // sees before importing is the whole truth about what the project points at.
    const listed = new Set(manifest.sources.map((source) => source.key));
    const unlisted = studioBundleSourceKeys(project.envelope.graph).filter((source) => !listed.has(source.key));
    if (unlisted.length > 0) {
      throw new StudioBundleArchiveError(
        'bundle_manifest_invalid',
        `The manifest does not list ${unlisted.length} source(s) the project uses`,
      );
    }

    return { directory, manifest, envelope: project.envelope as StudioProjectEnvelope };
  }

  /**
   * Read the bundle and stream every embedded copy through its digest, reporting progress. Null
   * means the owner cancelled while it ran, which has already been acknowledged.
   */
  private async verifyBundle(source: ZipByteSource, id: string, claimToken: string) {
    const read = await this.readBundle(source);
    const names = Object.keys(read.manifest.files).filter((name) => name.startsWith(STUDIO_BUNDLE_MEDIA_PREFIX));
    const total = names.reduce((sum, name) => sum + read.manifest.files[name].bytes, 0);
    let done = 0;

    for (const name of names) {
      const expected = read.manifest.files[name];
      const actual = await digestZipEntry(source, read.directory.byName.get(name)!);
      if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
        throw new BundleJobError('bundle_digest_mismatch', `${name.slice(0, 80)} does not match its digest`);
      }
      done += actual.bytes;
      if (!(await this.progress(id, claimToken, { phase: 'verifying' }, done, total))) {
        return null;
      }
    }

    return { manifest: read.manifest, envelope: read.envelope, embeddedVerified: names.length };
  }

  /**
   * Keep the project files a bundle carries with the project the import created (FL-105).
   *
   * Each embedded copy is written out under a random name in the importer's own incoming folder
   * while its digest is checked again, then handed to the upload path, which reads the type from
   * the bytes, runs every check an upload gets (size, quota, graphics scan, caption and LUT
   * validation) and stores it as `<import id><extension>`. Nothing the manifest says about the file
   * reaches the disk: its name is a label and its type only settles what the bytes leave open, as
   * a browser's does. Returns the files the checks refused; anything else that fails throws.
   */
  private async keepCarriedImports(
    owner: AuthDto,
    bundlePath: string,
    manifest: StudioBundleManifest,
    projectId: string,
  ): Promise<StudioBundleMissingSource[]> {
    const carried = studioBundleImportSources(manifest.sources)
      .values()
      .filter((source) => source.mode === 'embedded')
      .toArray();
    if (carried.length === 0) {
      return [];
    }
    const refused: StudioBundleMissingSource[] = [];
    const folder = studioImportIncomingFolder(owner.user.id);
    this.storage.mkdirSync(folder);

    await this.withArchive(bundlePath, async (source) => {
      const directory = await readZipDirectory(source);
      for (const item of carried) {
        const name = item.path ?? '';
        const entry = directory.byName.get(name);
        const expected = manifest.files[name];
        if (!entry || !expected) {
          throw new BundleJobError('bundle_entry_missing', `${name.slice(0, 80)} is listed but not in the file`);
        }
        const staged = join(folder, `${randomUUID()}.upload`);
        const reservation = await this.projects.createUpload({
          ownerId: owner.user.id,
          path: staged,
          sizeBytes: expected.bytes,
          digest: '',
          originalFileName: '',
          manifest: {},
          expiresAt: hoursFrom(new Date(), STUDIO_BUNDLE_UPLOAD_TTL_HOURS),
        });
        try {
          const output: Writable = this.storage.createWriteStream(staged);
          try {
            const actual = await digestZipEntry(source, entry, {
              onData: (chunk) =>
                new Promise<void>((resolve, reject) =>
                  output.write(chunk, (error) => (error ? reject(error) : resolve())),
                ),
            });
            output.end();
            await streamFinished(output);
            if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
              throw new BundleJobError('bundle_digest_mismatch', `${name.slice(0, 80)} does not match its digest`);
            }
          } catch (error) {
            output.destroy();
            await this.storage.unlink(staged);
            throw error;
          }
          try {
            // The upload path removes the staged file itself when it refuses it.
            await this.imports.upload(
              owner,
              projectId,
              item.id,
              {
                path: staged,
                size: expected.bytes,
                mimetype: item.contentType ?? '',
                originalname: item.fileName ?? '',
              } as Express.Multer.File,
              reservation.id,
            );
          } catch (error) {
            if (!(error instanceof BadRequestException || error instanceof PayloadTooLargeException)) {
              throw error;
            }
            this.logger.warn(`Studio bundle import: project file ${item.id} was not kept: ${errorMessage(error)}`);
            refused.push({ key: item.key, kind: item.kind, id: item.id, fileName: item.fileName, embedded: true });
          }
        } finally {
          await this.storage.unlink(staged);
          await this.projects.deleteUpload(reservation.id, owner.user.id);
        }
      }
    });
    return refused;
  }

  /**
   * The reference keys, among these, that FL-90 authorizes for this account right now, as a person
   * placing them in Studio would be: owned or shared, not Locked, not trashed, not hidden.
   */
  private async authorizedKeys(
    auth: AuthDto,
    contextId: string,
    items: ReadonlyArray<{ kind: StudioResourceKind; id: string }>,
  ): Promise<Set<string>> {
    if (items.length === 0) {
      return new Set();
    }
    const { manifest } = await this.resources.resolveProjectResources(auth, {
      projectId: contextId,
      ownerId: auth.user.id,
      revision: 0,
      graph: graphNaming(items),
      destination: StudioDestination.Local,
    });
    return new Set(manifest.entries.map((entry) => entry.key));
  }

  /** Record progress and learn about a cancel in the same round trip. False means stop now. */
  private async progress(
    id: string,
    claimToken: string,
    result: Record<string, unknown>,
    done: number,
    total: number,
  ): Promise<boolean> {
    const written = await this.operations.setBulkResult(id, claimToken, {
      result,
      processedUnits: done,
      totalUnits: total,
      progress: total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0,
      leaseMs: STUDIO_BUNDLE_LEASE_MS,
    });
    if (!written) {
      this.logger.warn(`Studio bundle job ${id}: claim lost, stopping`);
      return false;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      this.logger.log(`Studio bundle job ${id} cancelled by its owner`);
      return false;
    }
    if (written.status === MediaOperationStatus.Preparing) {
      await this.operations.reportProgress(id, claimToken, {
        status: MediaOperationStatus.Rendering,
        processedUnits: done,
        totalUnits: total,
        progress: total > 0 ? Math.min(99, Math.floor((done / total) * 100)) : 0,
      });
    }
    return true;
  }

  /** Publish the result. False when the owner cancelled at the last moment; the cancel is acknowledged. */
  private async finish(id: string, claimToken: string, result: Record<string, unknown>, total: number) {
    const written = await this.operations.setBulkResult(id, claimToken, {
      result,
      processedUnits: total,
      totalUnits: total,
      progress: 100,
      leaseMs: STUDIO_BUNDLE_LEASE_MS,
    });
    if (!written) {
      throw new BundleJobError('bundle_claim_lost', 'The job was taken over before it could finish');
    }
    if (
      (await this.operations.beginValidation(id, claimToken)) &&
      (await this.operations.complete(id, claimToken, { resultAssetId: null }))
    ) {
      return true;
    }
    await this.operations.acknowledgeCancel(id, claimToken, { released: false });
    return false;
  }

  /**
   * The owner, acting through the worker. An export reads files as a background runner (owner
   * decision, September 22, 2026) and so is elevated; an import decides what the new project may
   * point at exactly as an interactive Studio session would, and so is not.
   */
  private async authFor(ownerId: string, { elevated }: { elevated: boolean }): Promise<AuthDto | null> {
    const user = await this.users.get(ownerId, { withDeleted: false });
    if (!user) {
      return null;
    }
    return {
      user: {
        id: user.id,
        isAdmin: user.isAdmin,
        name: user.name,
        email: user.email,
        quotaUsageInBytes: user.quotaUsageInBytes,
        quotaSizeInBytes: user.quotaSizeInBytes,
      },
      session: { id: this.sessionId, hasElevatedPermission: elevated },
    };
  }

  private requireInteractive(auth: AuthDto) {
    if (auth.sharedLink) {
      throw new ForbiddenException('Studio bundles are not available on a shared link');
    }
  }

  /**
   * FL-195 follow-up: a bundle an unlocked owner exported carries the files of their revealed items.
   * It is hidden, like those items, from a session that may not see one of them — decided as the items
   * stand now, so an item locked after the export hides the bundle too — and answers as not found.
   */
  private async requireCarriedItemsVisible(auth: AuthDto, operation: MediaOperation): Promise<void> {
    if (operation.kind !== MediaOperationKind.StudioBundleExport) {
      return;
    }
    const embed = (operation.snapshot as { embed?: Array<{ id?: unknown }> } | null)?.embed ?? [];
    const ids = embed.map((item) => item.id).filter((id): id is string => typeof id === 'string');
    if (ids.length > 0 && (await this.studio.hiddenOwnedItems(auth, ids)).size > 0) {
      throw new NotFoundException('Studio bundle not found');
    }
  }

  private async findOwnedBundle(auth: AuthDto, id: string): Promise<MediaOperation> {
    this.requireInteractive(auth);
    const operation = await this.operations.getForOwner(id, auth.user.id);
    if (!operation || !(STUDIO_BUNDLE_KINDS as readonly string[]).includes(operation.kind)) {
      throw new NotFoundException('Studio bundle not found');
    }
    return operation;
  }

  private async findUpload(auth: AuthDto, id: string): Promise<StudioBundleUpload> {
    this.requireInteractive(auth);
    const upload = await this.projects.getUpload(id, auth.user.id);
    if (!upload) {
      throw new NotFoundException('Studio bundle upload not found');
    }
    return upload;
  }

  /** The manifest stored at registration, validated again: the column is data, not trust. */
  private storedManifest(upload: StudioBundleUpload): StudioBundleManifest {
    const checked = checkStudioBundleManifest(upload.manifest);
    if (!checked.ok) {
      throw new BadRequestException('This upload can no longer be read; upload the bundle again');
    }
    return checked.manifest;
  }

  /**
   * The review the person sees before importing: for every source, whether the original already
   * resolves for them, whether an item of theirs has the same content, or whether it is missing.
   * Content matches are SHA-256 only, and each candidate passes the same FL-90 decision as a
   * choice made by hand.
   */
  private async mapUpload(
    auth: AuthDto,
    upload: StudioBundleUpload,
    manifest: StudioBundleManifest,
  ): Promise<StudioBundleUploadDto> {
    // Files kept with the project come with the bundle or not at all: never matched to library
    // items, and not listed a second time under the media id a clip places them by.
    const carried = studioBundleImportSources(manifest.sources);
    const dependencyGraph = manifest.sources.some(
      (source) => source.kind === StudioResourceKind.LibraryAsset && carried.has(source.id),
    )
      ? await this.withArchive(upload.path, async (source) => (await this.readBundle(source)).envelope.graph)
      : undefined;
    const relinkable = manifest.sources.filter(
      (source) =>
        source.kind !== StudioResourceKind.ProjectImport &&
        !isStudioBundleImportAlias(source, carried, dependencyGraph),
    );
    const kept = await this.authorizedKeys(auth, upload.id, relinkable);
    for (const source of carried.values()) {
      if (source.mode === 'embedded') {
        kept.add(source.key);
      }
    }

    const wanted = relinkable.filter((source) => !kept.has(source.key) && source.sha256);
    const candidates = new Map<string, string>();
    if (wanted.length > 0) {
      const rows = await this.assets.getByChecksums(
        auth.user.id,
        wanted.map((source) => Buffer.from(source.sha256 as string, 'hex')),
      );
      const byDigest = new Map<string, string>();
      for (const row of rows) {
        const hex = studioChecksumSha256(row.checksum);
        if (hex && !row.deletedAt && !byDigest.has(hex)) {
          byDigest.set(hex, row.id);
        }
      }
      const proposals = wanted
        .map((source) => ({ source, assetId: byDigest.get(source.sha256 as string) }))
        .filter((proposal): proposal is { source: StudioBundleSource; assetId: string } => !!proposal.assetId);
      const allowed = await this.authorizedKeys(
        auth,
        upload.id,
        proposals.map((proposal) => ({ kind: proposal.source.kind, id: proposal.assetId })),
      );
      for (const proposal of proposals) {
        if (allowed.has(studioReferenceKey({ kind: proposal.source.kind, id: proposal.assetId }))) {
          candidates.set(proposal.source.key, proposal.assetId);
        }
      }
    }

    const sources: StudioBundleSourceDto[] = [...relinkable, ...carried.values()].map((source) => {
      const suggested = candidates.get(source.key) ?? null;
      return {
        key: source.key,
        kind: source.kind,
        id: source.id,
        mode: source.mode,
        fileName: source.fileName,
        contentType: source.contentType,
        sizeBytes: source.bytes === null ? null : String(source.bytes),
        resolution: kept.has(source.key) ? 'kept' : suggested ? 'suggested' : 'missing',
        suggestedAssetId: kept.has(source.key) ? null : suggested,
      };
    });

    return {
      id: upload.id,
      fileName: upload.originalFileName,
      sizeBytes: String(upload.sizeBytes),
      digest: upload.digest,
      expiresAt: asIso(upload.expiresAt) as string,
      consumedAt: asIso(upload.consumedAt),
      projectName: manifest.project.name,
      revision: manifest.project.revision,
      exportedAt: manifest.createdAt,
      engineRevision: manifest.engine.engineRevision,
      producerVersion: manifest.producer.version,
      sources,
    };
  }
}
