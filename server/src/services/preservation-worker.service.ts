import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import z from 'zod';
import type { UpdateAssetDto } from 'src/dtos/asset.dto.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnEvent } from 'src/decorators.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetEditActionItem, AssetEditsCreateDto } from 'src/dtos/editing.dto.js';
import {
  AlbumKind,
  AlbumUserRole,
  AssetLockReason,
  AssetOrder,
  AssetVisibility,
  ImmichWorker,
  MediaOperationKind,
  MediaOperationStatus,
  StorageFolder,
} from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import {
  PreservationFileRepository,
  PreservationPackageSource,
} from 'src/repositories/preservation-files.repository.js';
import {
  PreservationItem,
  PreservationPackage,
  PreservationRepository,
  PreservationRestore,
  PreservationRestoreItem,
} from 'src/repositories/preservation.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { StackService } from 'src/services/stack.service.js';
import { cropBoxOf, isRegionInsideCrop } from 'src/utils/documents.js';
import {
  GENERATED_DESCRIPTION_MARK,
  PRESERVATION_ALBUMS_ENTRY,
  PRESERVATION_FORMAT,
  PRESERVATION_INDEX_ENTRY,
  PRESERVATION_ITEM_ATTEMPTS,
  PRESERVATION_KINDS,
  PRESERVATION_MANIFEST_ENTRY,
  PRESERVATION_MAX_COLLECTION_BYTES,
  PRESERVATION_MAX_INDEX_LINE_BYTES,
  PRESERVATION_MAX_MANIFEST_BYTES,
  PRESERVATION_MAX_SIDECAR_BYTES,
  PRESERVATION_PEOPLE_ENTRY,
  PRESERVATION_SCHEMA_VERSION,
  PRESERVATION_SUPPORT,
  PRESERVATION_SUPPORT_CATEGORIES,
  PRESERVATION_TAGS_ENTRY,
  PreservationAlbum,
  PreservationAlbumsSchema,
  PreservationDocument,
  PreservationEntry,
  PreservationEntrySchema,
  PreservationFileDigest,
  PreservationManifest,
  PreservationManifestSchema,
  PreservationPackageError,
  PreservationPeopleSchema,
  PreservationPerson,
  PreservationSidecar,
  PreservationSidecarSchema,
  PreservationSupportLevel,
  PreservationTagsSchema,
  PreservationVerification,
  checkPreservationEntry,
  checkPreservationJson,
  compareWithLibrary,
  fieldsToRestore,
  manualDescription,
  matchesDigest,
  orderPreservationAlbums,
  parsePreservationSnapshot,
  preservationDerivedId,
  preservationEntryNames,
  preservationJson,
  preservationProgress,
  restorableRating,
  restoredAlbumParent,
  sameReviewedDocuments,
  sanitizeDecisions,
  splitDescription,
  verificationStatus,
} from 'src/utils/preservation.js';
import { canonicalJson } from 'src/utils/studio-project.js';
import { upsertTags } from 'src/utils/tag.js';

/** How often the worker looks for queued preservation jobs. */
export const PRESERVATION_TICK_MS = 5000;
/** The claim lease. Extended with every item; a worker that stops writing loses the job. */
export const PRESERVATION_LEASE_MS = 2 * 60_000;
/** How long a restore waits for new originals' metadata before trying their edit recipes again. */
export const PRESERVATION_EDIT_WAIT_MS = 60_000;
/** How many times a restore waits for that before it reports the recipe as not applied. */
export const PRESERVATION_EDIT_WAITS = 10;
/** How often uploaded packages past their expiry are looked for. */
const SWEEP_MS = 10 * 60_000;
/** Items per page the worker reads from the database. */
const PAGE = 50;

const FINDING_EDIT_WAITING = 'edit_recipe_waiting';

type RunningJob = { operation: MediaOperation; claimToken: string };
type Outcome = 'copied' | 'failed' | 'skipped';

type RestoreContext = {
  auth: AuthDto;
  ownerId: string;
  restore: PreservationRestore;
  source: PreservationPackageSource;
  albums: Map<string, string>;
  people: Map<string, string>;
  restoreEditRecipes: boolean;
  conflictDefault: 'keep' | 'replace';
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Operator detail without server paths: a message may be shown to the owner. */
const describe = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replaceAll(/(?:\/[\w .@-]+){2,}/g, '[path]').slice(0, 500);

const errnoOf = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

const codeOf = (error: unknown, fallback: string) => {
  if (error instanceof PreservationPackageError) {
    return error.code;
  }
  switch (errnoOf(error)) {
    case 'ENOENT': {
      return 'original_missing';
    }
    case 'ENOSPC': {
      return 'package_no_space';
    }
    case 'EACCES':
    case 'EPERM': {
      return 'original_unreadable';
    }
    default: {
      return fallback;
    }
  }
};

const iso = (value: Date | string | null | undefined) =>
  value ? (value instanceof Date ? value.toISOString() : new Date(value).toISOString()) : null;

const dateOnly = (value: Date | string | null | undefined) => iso(value)?.slice(0, 10) ?? null;

type RegionColumns = {
  x1: number | null;
  y1: number | null;
  x2: number | null;
  y2: number | null;
  x3: number | null;
  y3: number | null;
  x4: number | null;
  y4: number | null;
};

/** The region a document decision was made against, or null when it was made without one. */
const regionOfEdit = ({ x1, y1, x2, y2, x3, y3, x4, y4 }: RegionColumns) =>
  x1 === null || y1 === null || x2 === null || y2 === null || x3 === null || y3 === null || x4 === null || y4 === null
    ? null
    : { x1, y1, x2, y2, x3, y3, x4, y4 };

/** Face regions compared independently of the image size each was measured on. */
const overlap = (
  a: { x1: number; y1: number; x2: number; y2: number; width: number; height: number },
  b: { x1: number; y1: number; x2: number; y2: number; width: number; height: number },
) => {
  const na = { x1: a.x1 / a.width, y1: a.y1 / a.height, x2: a.x2 / a.width, y2: a.y2 / a.height };
  const nb = { x1: b.x1 / b.width, y1: b.y1 / b.height, x2: b.x2 / b.width, y2: b.y2 / b.height };
  const width = Math.max(0, Math.min(na.x2, nb.x2) - Math.max(na.x1, nb.x1));
  const height = Math.max(0, Math.min(na.y2, nb.y2) - Math.max(na.y1, nb.y1));
  const intersection = width * height;
  const union = (na.x2 - na.x1) * (na.y2 - na.y1) + (nb.x2 - nb.x1) * (nb.y2 - nb.y1) - intersection;
  return union > 0 ? intersection / union : 0;
};

/**
 * The worker behind preservation packages (FL-74, `IMP-006`).
 *
 * Four kinds of durable media operation, claimed on the microservices worker like bulk work and
 * Studio bundles, and shown in Activity beside them:
 *
 * - **Export** copies the frozen selection item by item into the package directory, each original
 *   checked against the library checksum and each sidecar written beside it, then publishes the
 *   index documents and the manifest.
 * - **Verify** reads the package back, manifest first, and checks every original and sidecar
 *   against its digest, recording each item as ok, missing or changed.
 * - **Review** does the same for a package about to be restored and compares every item with the
 *   library: new, already held, or in the trash, and which fields disagree.
 * - **Restore** adds the originals the library does not hold, matches the ones it does, and applies
 *   the package's metadata by the owner's choices.
 *
 * Every step is recorded per item before the next begins, so a pause, a restart or the one automatic
 * retry every operation gets (owner decision, September 22, 2026) carries on from what is left and
 * never does an item twice. Items get the same: one automatic retry each, then they are reported.
 *
 * The worker acts for the owner as a background runner (owner decision, September 22, 2026): it can
 * read and restore Locked media. What reaches a package was frozen at submit by the owner's session,
 * so the worker never adds Locked media the owner did not ask for from an unlocked session.
 */
@Injectable()
export class PreservationWorkerService {
  private tickHandle?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private stopping = false;
  private lastSweepAt = 0;
  private readonly workerId = `preservation-${randomUUID()}`;
  /** Stands in for a session on the worker's auth; nothing on these paths reads it back. */
  private readonly sessionId = randomUUID();

  constructor(
    private logger: LoggingRepository,
    private operations: MediaOperationRepository,
    private repository: PreservationRepository,
    private files: PreservationFileRepository,
    private users: UserRepository,
    private albumRepository: AlbumRepository,
    private tagRepository: TagRepository,
    private enrichment: ForkEnrichmentRepository,
    private assetMedia: AssetMediaService,
    private assets: AssetService,
    private albums: AlbumService,
    private stacks: StackService,
  ) {
    this.logger.setContext(PreservationWorkerService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Scheduling                                                           */
  /* ------------------------------------------------------------------ */

  @OnEvent({ name: 'AppBootstrap', workers: [ImmichWorker.Microservices] })
  onBootstrap() {
    this.stopping = false;
    this.tickHandle ??= setInterval(() => this.tick(), PRESERVATION_TICK_MS);
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

  tick() {
    if (this.active || this.stopping) {
      return;
    }
    this.active = this.drain()
      .catch((error) => this.logger.warn(`Preservation worker failed: ${describe(error)}`))
      .finally(() => {
        this.active = undefined;
      });
  }

  /**
   * Work through the queue until it is empty or we are stopping. Lapsed claims are recovered by
   * `MediaOperationSweepService` with every other kind, so a lapsed claim is judged once (FL-104).
   */
  async drain(): Promise<void> {
    await this.sweep();
    while (!this.stopping) {
      const claim = await this.operations.claimNext({
        kinds: PRESERVATION_KINDS,
        workerId: this.workerId,
        leaseMs: PRESERVATION_LEASE_MS,
      });
      if (!claim) {
        return;
      }
      await this.run(claim);
    }
  }

  /** Uploaded packages past their expiry: the file is removed and the row kept for its restorations. */
  async sweep(now: Date = new Date()): Promise<void> {
    if (now.getTime() - this.lastSweepAt < SWEEP_MS) {
      return;
    }
    this.lastSweepAt = now.getTime();
    for (const expired of await this.repository.listExpiredUploads(now)) {
      if (await this.repository.activeOperation(expired.ownerId, 'packageId', expired.id)) {
        continue;
      }
      await this.files.removeFile(expired.path);
      await this.repository.updatePackage(expired.id, { status: 'removed', removedAt: now });
    }
  }

  /**
   * Run one claimed job. A failure of the whole job goes through the one automatic retry every media
   * operation gets (`MediaOperationRepository.fail`); everything below is safe to repeat.
   */
  async run(job: RunningJob): Promise<void> {
    const { operation, claimToken } = job;
    try {
      const snapshot = parsePreservationSnapshot(operation.kind, operation.snapshot);
      const key = 'restoreId' in snapshot ? 'restoreId' : 'packageId';
      const subject = 'restoreId' in snapshot ? snapshot.restoreId : snapshot.packageId;
      // Two jobs never work on one package or restoration at once; the later one waits its turn.
      if (await this.repository.otherClaimedOperation(operation.ownerId, key, subject, operation.id)) {
        if (!(await this.operations.requeue(operation.id, claimToken, { delayMs: PRESERVATION_TICK_MS * 6 }))) {
          // Refused only for a cancel the owner asked for meanwhile: settle it rather than leave it.
          await this.operations.acknowledgeCancel(operation.id, claimToken, { released: false });
        }
        return;
      }

      switch (operation.kind) {
        case MediaOperationKind.PreservationExport: {
          await this.runExport(job, snapshot.packageId);
          break;
        }
        case MediaOperationKind.PreservationVerify: {
          await this.runVerify(job, snapshot.packageId);
          break;
        }
        case MediaOperationKind.PreservationReview: {
          await this.runReview(job, 'restoreId' in snapshot ? snapshot.restoreId : '');
          break;
        }
        case MediaOperationKind.PreservationRestore: {
          await this.runRestore(job, 'restoreId' in snapshot ? snapshot.restoreId : '');
          break;
        }
        default: {
          throw new PreservationPackageError('package_unavailable', `Not a preservation job: ${operation.kind}`);
        }
      }
    } catch (error) {
      const failure = { error: describe(error), errorCode: codeOf(error, 'preservation_failed') };
      const outcome = await this.operations.fail(operation.id, claimToken, failure);
      if (outcome === 'retrying') {
        this.logger.warn(`Preservation job ${operation.id} failed and will be retried once: ${failure.error}`);
      } else if (outcome === 'failed') {
        this.logger.error(`Preservation job ${operation.id} failed: ${failure.error}`);
        await this.afterFailure(operation);
      } else {
        this.logger.warn(`Preservation job ${operation.id} failed after its claim was lost: ${failure.error}`);
      }
    }
  }

  /** A restoration whose job finally failed is ready to be tried again, not stuck as restoring. */
  private async afterFailure(operation: MediaOperation) {
    const restoreId = asRecord(operation.snapshot).restoreId;
    if (typeof restoreId !== 'string') {
      return;
    }
    const restore = await this.repository.getRestoreById(restoreId);
    if (restore?.status === 'restoring') {
      await this.repository.updateRestore(restore.id, { status: 'ready' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Export                                                               */
  /* ------------------------------------------------------------------ */

  private async runExport({ operation, claimToken }: RunningJob, packageId: string): Promise<void> {
    const found = await this.repository.getPackageById(packageId);
    if (!found || found.ownerId !== operation.ownerId || found.origin !== 'export' || found.removedAt) {
      throw new PreservationPackageError('package_unavailable', 'The package is gone');
    }
    if (!(await this.users.get(found.ownerId, { withDeleted: false }))) {
      throw new PreservationPackageError(
        'owner_unavailable',
        'The account that asked for this package no longer exists',
      );
    }

    const result = { phase: 'copying', packageId: found.id, copied: 0, failed: 0, skipped: 0 };
    let done = 0;
    let total = await this.repository.countExportWork(found.id, PRESERVATION_ITEM_ATTEMPTS);
    if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
      return;
    }

    // Every item once, then the ones that failed once more: the automatic retry each item gets.
    for (let pass = 0; pass < PRESERVATION_ITEM_ATTEMPTS; pass++) {
      if (pass > 0) {
        total = done + (await this.repository.countExportWork(found.id, PRESERVATION_ITEM_ATTEMPTS));
      }
      let after: string | null = null;
      for (;;) {
        const page: PreservationItem[] = await this.repository.exportWork(
          found.id,
          after,
          PAGE,
          PRESERVATION_ITEM_ATTEMPTS,
        );
        if (page.length === 0) {
          break;
        }
        for (const item of page) {
          after = item.id;
          const outcome = await this.exportItem(found, item);
          result[outcome]++;
          done++;
          if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
            return;
          }
        }
      }
    }

    result.phase = 'publishing';
    if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
      return;
    }
    const published = await this.publishPackage(found);
    await this.finish(operation.id, claimToken, { ...result, phase: 'done', ...published }, done);
    this.logger.log(
      `Preservation package ${found.id} written: ${published.exported} copied, ${published.failed} failed, ${published.skipped} skipped`,
    );
  }

  /** Copy one original and write its sidecar. Never throws for the item; a full disk stops the job. */
  private async exportItem(found: PreservationPackage, item: PreservationItem): Promise<Outcome> {
    await this.repository.beginItemAttempt(item.id);
    try {
      const asset = await this.repository.getExportAsset(item.sourceAssetId);
      if (!asset || asset.ownerId !== found.ownerId || asset.deletedAt || asset.status !== 'active') {
        await this.repository.finishItem(item.id, { state: 'skipped', reasonKey: 'asset_unavailable' });
        return 'skipped';
      }
      // Locked after the package was asked for, from a session that did not include Locked items.
      if (asset.isLocked && !found.includeLocked) {
        await this.repository.finishItem(item.id, { state: 'skipped', reasonKey: 'locked_excluded', locked: true });
        return 'skipped';
      }
      if (asset.isOffline) {
        throw new PreservationPackageError('original_offline', 'The original is offline');
      }

      const names = preservationEntryNames(asset.id, asset.originalFileName);
      const destination = join(found.path, names.original);
      const digests = await this.files.copyOriginal(asset.originalPath, destination);
      const expected = Buffer.from(asset.checksum).toString('hex');
      const measured = asset.checksum.length === 20 ? digests.sha1 : digests.sha256;
      if (expected !== measured) {
        await this.files.removeFile(destination);
        throw new PreservationPackageError('checksum_mismatch', 'The original does not match its library checksum');
      }

      let metadata: (PreservationFileDigest & { path: string }) | null = null;
      if (found.includeMetadata) {
        const sidecar = await this.buildSidecar(found.ownerId, asset, digests);
        const written = await this.files.writeDocument(join(found.path, names.metadata), preservationJson(sidecar));
        metadata = { path: names.metadata, sha256: written.sha256, bytes: written.bytes };
      }

      const entry: PreservationEntry = {
        sourceAssetId: asset.id,
        originalFileName: asset.originalFileName,
        type: asset.type as PreservationEntry['type'],
        locked: !!asset.isLocked,
        original: { path: names.original, sha1: digests.sha1, sha256: digests.sha256, bytes: digests.bytes },
        metadata,
      };
      await this.repository.finishItem(item.id, { state: 'copied', entry, locked: !!asset.isLocked });
      return 'copied';
    } catch (error) {
      const reasonKey = codeOf(error, 'item_failed');
      await this.repository.finishItem(item.id, { state: 'failed', reasonKey, error: describe(error) });
      if (reasonKey === 'package_no_space') {
        throw error;
      }
      return 'failed';
    }
  }

  /**
   * Everything the library knows about one original that a restoration can use or should record.
   * Only the owner's own organization: their tags, their albums, their named people. Hidden and
   * cropped-away text evidence is left out: a document decision is kept only where its region is
   * still in the picture, and the recognized text it was made against is never copied.
   */
  private async buildSidecar(
    ownerId: string,
    asset: NonNullable<Awaited<ReturnType<PreservationRepository['getExportAsset']>>>,
    digests: { sha1: string; sha256: string },
  ): Promise<PreservationSidecar> {
    const [lock, tags, albums, faces, recipe, documents, moments, stack, enrichment] = await Promise.all([
      asset.isLocked ? this.repository.getLock(asset.id) : Promise.resolve(undefined),
      this.repository.getTagValues(asset.id, ownerId),
      this.repository.getOwnedAlbumIds(asset.id, ownerId),
      this.repository.getNamedFaces(asset.id, ownerId),
      this.repository.getEditRecipe(asset.id),
      this.repository.getDocumentEdits(asset.id),
      this.repository.getMoments(asset.id),
      asset.stackId ? this.repository.getStackPrimary(asset.stackId) : Promise.resolve(undefined),
      this.enrichmentProvenance(asset.id, asset.description ?? null),
    ]);

    const crop = cropBoxOf(recipe as unknown as AssetEditActionItem[]);
    const width = asset.width ?? asset.exifImageWidth ?? null;
    const height = asset.height ?? asset.exifImageHeight ?? null;
    const keptDocuments = documents.filter((document) => {
      const region = regionOfEdit(document);
      if (!region || !crop) {
        return true;
      }
      // Unknown geometry under a crop keeps the decision out rather than risk cropped-away text.
      return !!width && !!height && isRegionInsideCrop(region, { width, height }, crop);
    });

    const sidecar: PreservationSidecar = {
      schemaVersion: PRESERVATION_SCHEMA_VERSION,
      sourceAssetId: asset.id,
      originalFileName: asset.originalFileName,
      type: asset.type as PreservationSidecar['type'],
      checksum: { sha1: digests.sha1, sha256: digests.sha256 },
      dates: {
        fileCreatedAt: iso(asset.fileCreatedAt)!,
        fileModifiedAt: iso(asset.fileModifiedAt)!,
        localDateTime: iso(asset.localDateTime),
        dateTimeOriginal: iso(asset.dateTimeOriginal),
        timeZone: asset.timeZone ?? null,
      },
      isFavorite: asset.isFavorite,
      visibility:
        asset.visibility === AssetVisibility.Archive
          ? 'archive'
          : asset.visibility === AssetVisibility.Hidden
            ? 'hidden'
            : 'timeline',
      lock:
        asset.isLocked && lock
          ? { reason: lock.reason as NonNullable<PreservationSidecar['lock']>['reason'], lockedAt: iso(lock.lockedAt) }
          : null,
      location:
        asset.latitude === null ||
        asset.longitude === null ||
        asset.latitude === undefined ||
        asset.longitude === undefined
          ? null
          : {
              latitude: asset.latitude,
              longitude: asset.longitude,
              city: asset.city?.slice(0, 1024) ?? null,
              state: asset.state?.slice(0, 1024) ?? null,
              country: asset.country?.slice(0, 1024) ?? null,
            },
      description: enrichment.manual
        ? { text: enrichment.manual.slice(0, 65_536), source: 'manual', model: null }
        : null,
      rating: asset.rating ?? null,
      camera: {
        make: asset.make?.slice(0, 1024) ?? null,
        model: asset.model?.slice(0, 1024) ?? null,
        lensModel: asset.lensModel?.slice(0, 1024) ?? null,
        fNumber: asset.fNumber ?? null,
        focalLength: asset.focalLength ?? null,
        iso: asset.iso ?? null,
        exposureTime: asset.exposureTime?.slice(0, 1024) ?? null,
        width: asset.exifImageWidth ?? null,
        height: asset.exifImageHeight ?? null,
        orientation: asset.orientation?.slice(0, 1024) ?? null,
        projectionType: asset.projectionType?.slice(0, 1024) ?? null,
      },
      tags: tags.slice(0, 1000),
      albums: albums.slice(0, 10_000),
      faces: faces.slice(0, 1000).map((face) => ({
        personId: face.personGroupId!,
        imageWidth: Math.max(1, face.imageWidth),
        imageHeight: Math.max(1, face.imageHeight),
        x1: face.boundingBoxX1,
        y1: face.boundingBoxY1,
        x2: face.boundingBoxX2,
        y2: face.boundingBoxY2,
        sourceType: face.sourceType as PreservationSidecar['faces'][number]['sourceType'],
      })),
      livePhotoVideoId: asset.livePhotoVideoId ?? null,
      stack: stack ? { id: stack.id, primaryAssetId: stack.primaryAssetId } : null,
      edits: {
        isEdited: asset.isEdited,
        recipe: recipe.slice(0, 100).map((edit) => ({
          action: edit.action as string,
          parameters: edit.parameters as unknown as Record<string, unknown>,
        })),
      },
      documents: keptDocuments.slice(0, 2000).map((document) => ({
        key: document.key.slice(0, 256),
        action: document.action as 'confirm' | 'correct' | 'dismiss',
        value: document.value === null ? null : document.value.slice(0, 10_000),
        region: regionOfEdit(document),
      })),
      moments: {
        manual: moments
          .filter((moment) => moment.source === 'manual')
          .slice(0, 2000)
          .map((moment) => ({
            timestampMs: moment.timestampMs,
            endMs: moment.endMs,
            caption: moment.caption === null ? null : moment.caption.slice(0, 10_000),
            transcript: moment.transcript === null ? null : moment.transcript.slice(0, 100_000),
          })),
        generated: moments
          .filter((moment) => moment.source !== 'manual')
          .slice(0, 2000)
          .map((moment) => ({
            timestampMs: moment.timestampMs,
            endMs: moment.endMs,
            caption: moment.caption === null ? null : moment.caption.slice(0, 10_000),
            provenance: moment.provenance ?? null,
          })),
      },
      provenance: {
        restoration: 'provenance-only',
        generatedDescriptions: enrichment.generated,
        enrichment: enrichment.metadata,
      },
    };

    const checked = PreservationSidecarSchema.safeParse(sidecar);
    if (!checked.success) {
      const issue = checked.error.issues[0];
      throw new PreservationPackageError(
        'metadata_invalid',
        `The metadata of this item cannot be written: ${issue?.path.join('.')}: ${issue?.message}`.slice(0, 300),
      );
    }
    return checked.data;
  }

  /**
   * What produced the description: the owner's text and, separately, what enrichment generated and
   * with which model. Read from the fork sidecar once it is authoritative, and from the stored
   * description and its enrichment metadata before that, exactly as enrichment itself reads them.
   */
  private async enrichmentProvenance(assetId: string, description: string | null) {
    let metadata: Record<string, unknown> | null;
    let manual: string | null;
    let generated: string[];
    if (await this.enrichment.shouldReadSidecar()) {
      const sidecar = await this.enrichment.get(assetId);
      metadata = sidecar ? asRecord(sidecar.provenance) : null;
      manual = sidecar?.userDescription?.trim() ? sidecar.userDescription : splitDescription(description).manual;
      generated = sidecar?.generatedDescription
        ? [sidecar.generatedDescription]
        : splitDescription(description).generated;
    } else {
      const row = await this.repository.getEnrichmentMetadata(assetId);
      metadata = row ? asRecord(row.value) : null;
      ({ manual, generated } = splitDescription(description));
    }
    return { manual, generated, metadata };
  }

  /** Write the index documents and the manifest, and publish the package. */
  private async publishPackage(found: PreservationPackage) {
    const files: Partial<Record<PreservationDocument, PreservationFileDigest>> = {};

    if (found.includeMetadata) {
      const albumRows = await this.repository.getPackageAlbums(found.id, found.ownerId);
      const albumIds = new Set(albumRows.map((row) => row.id));
      const albums: PreservationAlbum[] = albumRows.map((row) => ({
        id: row.id,
        name: row.albumName.slice(0, 1024),
        description: (row.description ?? '').slice(0, 65_536),
        kind: row.kind === 'collection' ? 'collection' : 'album',
        parentId: row.parentId && albumIds.has(row.parentId) ? row.parentId : null,
        icon: row.icon?.slice(0, 256) ?? null,
        order: row.order === 'asc' || row.order === 'desc' ? row.order : null,
      }));
      const people: PreservationPerson[] = (await this.repository.getPackagePeople(found.id, found.ownerId)).map(
        (row) => ({
          id: row.personGroupId,
          name: row.name.slice(0, 1024),
          birthDate: dateOnly(row.birthDate),
          isHidden: row.isHidden,
          isFavorite: row.isFavorite,
          color: row.color?.slice(0, 32) ?? null,
        }),
      );
      const tags = (await this.repository.getPackageTags(found.id, found.ownerId)).map((row) => ({
        value: row.value.slice(0, 1024),
        color: row.color?.slice(0, 32) ?? null,
      }));
      files[PRESERVATION_ALBUMS_ENTRY] = await this.files.writeDocument(
        join(found.path, PRESERVATION_ALBUMS_ENTRY),
        preservationJson(albums),
      );
      files[PRESERVATION_PEOPLE_ENTRY] = await this.files.writeDocument(
        join(found.path, PRESERVATION_PEOPLE_ENTRY),
        preservationJson(people),
      );
      files[PRESERVATION_TAGS_ENTRY] = await this.files.writeDocument(
        join(found.path, PRESERVATION_TAGS_ENTRY),
        preservationJson(tags),
      );
    }

    let exported = 0;
    let locked = 0;
    let bytes = 0;
    const keep = new Set<string>([PRESERVATION_MANIFEST_ENTRY, PRESERVATION_INDEX_ENTRY, ...Object.keys(files)]);
    const repository = this.repository;
    async function* pages() {
      let after: string | null = null;
      for (;;) {
        const page: PreservationItem[] = await repository.listedItems(found.id, after, 1000);
        if (page.length === 0) {
          return;
        }
        after = page.at(-1)!.sourceAssetId;
        const lines: string[] = [];
        for (const item of page) {
          const entry = PreservationEntrySchema.parse(item.entry);
          exported++;
          locked += entry.locked ? 1 : 0;
          bytes += entry.original.bytes + (entry.metadata?.bytes ?? 0);
          keep.add(entry.original.path);
          if (entry.metadata) {
            keep.add(entry.metadata.path);
          }
          lines.push(JSON.stringify(entry));
        }
        yield lines;
      }
    }
    const index = await this.files.writeLines(join(found.path, PRESERVATION_INDEX_ENTRY), pages());
    files[PRESERVATION_INDEX_ENTRY] = { sha256: index.sha256, bytes: index.bytes };

    const counts = (await this.repository.countItems([found.id])).get(found.id);
    const failed = counts?.states.failed ?? 0;
    const skipped = counts?.states.skipped ?? 0;
    // An original that could not be read is missing from the package just as a failed copy is.
    // Only a Locked item the package was asked to leave out is a skip that keeps it complete.
    const unavailable = counts?.unavailable ?? 0;
    const complete = failed === 0 && unavailable === 0;
    const support = Object.fromEntries(
      PRESERVATION_SUPPORT_CATEGORIES.map((category) => [
        category,
        found.includeMetadata || category === 'originals'
          ? PRESERVATION_SUPPORT[category]
          : ('not-included' as PreservationSupportLevel),
      ]),
    );
    const manifest: PreservationManifest = {
      format: PRESERVATION_FORMAT,
      schemaVersion: PRESERVATION_SCHEMA_VERSION,
      packageId: found.id,
      name: found.name.slice(0, 200),
      createdAt: new Date().toISOString(),
      producer: { product: 'frameleaf', version: serverVersion.toString().slice(0, 64) },
      scope: {
        description: String(asRecord(found.scope).description ?? '').slice(0, 2048),
        includeLocked: found.includeLocked,
        includeMetadata: found.includeMetadata,
      },
      counts: { selected: exported + failed + skipped, exported, failed, skipped, locked, bytes },
      complete,
      files,
      support,
    };
    const checked = PreservationManifestSchema.safeParse(manifest);
    if (!checked.success) {
      throw new PreservationPackageError('package_manifest_invalid', 'The manifest could not be written');
    }
    await this.files.writeDocument(join(found.path, PRESERVATION_MANIFEST_ENTRY), preservationJson(manifest));
    await this.removeLeftovers(found.path, keep);

    await this.repository.updatePackage(found.id, {
      status: complete ? 'ready' : 'incomplete',
      sizeBytes: bytes,
      manifest: {
        packageId: manifest.packageId,
        createdAt: manifest.createdAt,
        producerVersion: manifest.producer.version,
        complete: manifest.complete,
        counts: manifest.counts,
        scope: manifest.scope,
        files: manifest.files,
      },
      // Whatever an earlier verification said was about the package before this write.
      verification: null,
      verifiedAt: null,
    });
    return { exported, failed, skipped, locked, bytes };
  }

  /**
   * A package directory holds exactly what its index lists. Temporary files a stopped attempt left
   * behind, and the copy of an item that was later skipped — one that became Locked after the
   * package was asked for without Locked items, or left the library — are removed.
   */
  private async removeLeftovers(root: string, keep: ReadonlySet<string>) {
    const source = await this.files.openPackage('directory', root);
    try {
      for (const name of await source.listEntries()) {
        if (!name.endsWith('/') && !keep.has(name)) {
          await this.files.removeFile(join(root, name));
        }
      }
    } finally {
      await source.close();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Reading a package                                                    */
  /* ------------------------------------------------------------------ */

  /** The manifest, believed only when it parses and names an index. */
  private async readManifest(source: PreservationPackageSource): Promise<PreservationManifest> {
    const bytes = await source.readDocument(PRESERVATION_MANIFEST_ENTRY, PRESERVATION_MAX_MANIFEST_BYTES);
    const checked = checkPreservationJson(PreservationManifestSchema, bytes);
    if (!checked.ok) {
      throw new PreservationPackageError('package_manifest_invalid', `The manifest is not valid: ${checked.detail}`);
    }
    return checked.value;
  }

  /** A collection document, checked against its digest; missing when the manifest lists none. */
  private async readCollection<T>(
    source: PreservationPackageSource,
    manifest: PreservationManifest,
    name: PreservationDocument,
    schema: z.ZodType<T>,
  ): Promise<T | null> {
    const expected = manifest.files[name];
    if (!expected) {
      return null;
    }
    const bytes = await source.readDocument(name, PRESERVATION_MAX_COLLECTION_BYTES);
    if (!matchesDigest(bytes, expected)) {
      throw new PreservationPackageError('package_documents_changed', `${name} does not match its digest`);
    }
    const checked = checkPreservationJson(schema, bytes);
    if (!checked.ok) {
      throw new PreservationPackageError('package_documents_invalid', `${name} is not valid: ${checked.detail}`);
    }
    return checked.value;
  }

  /**
   * Read the index line by line, checking every line and the digest of the whole, and hand the
   * entries on in batches. Duplicate identities and a count that disagrees with the manifest are
   * refused: an index that lies about itself is not half-believed.
   */
  private async readIndex(
    source: PreservationPackageSource,
    manifest: PreservationManifest,
    onBatch: (entries: PreservationEntry[]) => Promise<void>,
  ): Promise<{ count: number; expectedNames: Set<string> }> {
    const expected = manifest.files[PRESERVATION_INDEX_ENTRY];
    if (!expected) {
      throw new PreservationPackageError('package_manifest_invalid', 'The manifest does not digest the index');
    }
    const seen = new Set<string>();
    const expectedNames = new Set<string>([PRESERVATION_MANIFEST_ENTRY, ...Object.keys(manifest.files)]);
    let batch: PreservationEntry[] = [];
    const each = async (line: string) => {
      if (!line.trim()) {
        return;
      }
      const checked = checkPreservationEntry(line);
      if (!checked.ok) {
        throw new PreservationPackageError('package_index_invalid', `An index line is not valid: ${checked.detail}`);
      }
      const entry = checked.value;
      if (seen.has(entry.sourceAssetId)) {
        throw new PreservationPackageError('package_index_invalid', 'The index lists an item twice');
      }
      seen.add(entry.sourceAssetId);
      expectedNames.add(entry.original.path);
      if (entry.metadata) {
        expectedNames.add(entry.metadata.path);
      }
      batch.push(entry);
      if (batch.length >= 500) {
        const full = batch;
        batch = [];
        await onBatch(full);
      }
    };
    const digest = await this.files.readLines(
      source,
      PRESERVATION_INDEX_ENTRY,
      PRESERVATION_MAX_INDEX_LINE_BYTES,
      each,
    );
    if (batch.length > 0) {
      await onBatch(batch);
    }
    if (digest.sha256 !== expected.sha256 || digest.bytes !== expected.bytes) {
      throw new PreservationPackageError('package_index_changed', 'The index does not match its digest');
    }
    if (seen.size !== manifest.counts.exported) {
      throw new PreservationPackageError('package_counts_changed', 'The index does not list what the manifest counts');
    }
    return { count: seen.size, expectedNames };
  }

  /** Check one original (and its sidecar) against the index. */
  private async checkItem(
    source: PreservationPackageSource,
    entry: PreservationEntry,
  ): Promise<'ok' | 'missing' | 'changed'> {
    try {
      const digests = await source.stream(entry.original.path);
      if (
        digests.bytes !== entry.original.bytes ||
        digests.sha256 !== entry.original.sha256 ||
        digests.sha1 !== entry.original.sha1
      ) {
        return 'changed';
      }
      if (entry.metadata) {
        const bytes = await source.readDocument(entry.metadata.path, PRESERVATION_MAX_SIDECAR_BYTES);
        if (!matchesDigest(bytes, entry.metadata)) {
          return 'changed';
        }
      }
      return 'ok';
    } catch (error) {
      if (error instanceof PreservationPackageError) {
        return error.code === 'package_entry_missing' ? 'missing' : 'changed';
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Verify                                                               */
  /* ------------------------------------------------------------------ */

  private async runVerify({ operation, claimToken }: RunningJob, packageId: string): Promise<void> {
    const found = await this.repository.getPackageById(packageId);
    if (!found || found.ownerId !== operation.ownerId || found.removedAt) {
      throw new PreservationPackageError('package_unavailable', 'The package is gone');
    }

    const previous = asRecord(operation.result);
    const result = {
      phase: 'reading',
      packageId: found.id,
      documentsChanged: Array.isArray(previous.documentsChanged) ? (previous.documentsChanged as string[]) : [],
      unexpected: typeof previous.unexpected === 'number' ? previous.unexpected : 0,
    };

    const source = await this.files.openPackage(found.format, found.path);
    try {
      if (previous.phase !== 'files') {
        if (!(await this.checkpoint(operation.id, claimToken, result, 0, 0))) {
          return;
        }
        let expectedNames: Set<string>;
        try {
          const manifest = await this.readManifest(source);
          // For a package this server wrote, the digests it published are on record: a manifest
          // that no longer carries them was rewritten.
          if (
            found.origin === 'export' &&
            canonicalJson(manifest.files) !== canonicalJson(asRecord(found.manifest).files ?? null)
          ) {
            throw new PreservationPackageError('package_manifest_changed', 'The manifest differs from the one written');
          }
          result.documentsChanged = [];
          for (const name of [PRESERVATION_ALBUMS_ENTRY, PRESERVATION_PEOPLE_ENTRY, PRESERVATION_TAGS_ENTRY] as const) {
            const expected = manifest.files[name];
            if (!expected) {
              continue;
            }
            try {
              const bytes = await source.readDocument(name, PRESERVATION_MAX_COLLECTION_BYTES);
              if (!matchesDigest(bytes, expected)) {
                result.documentsChanged.push(name);
              }
            } catch (error) {
              if (!(error instanceof PreservationPackageError)) {
                throw error;
              }
              result.documentsChanged.push(name);
            }
          }

          await this.repository.resetVerification(found.id);
          ({ expectedNames } = await this.readIndex(source, manifest, async (entries) => {
            if (found.origin === 'export') {
              // This server wrote the package, so its own record of each item is the reference: an
              // index line that disagrees with it was changed after the package was published.
              const known = await this.repository.itemIdsBySource(
                found.id,
                entries.map((entry) => entry.sourceAssetId),
              );
              const changed = entries.filter((entry) => {
                const item = known.get(entry.sourceAssetId);
                return !item || item.state !== 'copied' || canonicalJson(item.entry) !== canonicalJson(entry);
              });
              if (changed.length > 0) {
                throw new PreservationPackageError('package_index_changed', 'The index differs from what was written');
              }
            } else {
              await this.repository.upsertListedItems(
                found.id,
                entries.map((entry) => ({ sourceAssetId: entry.sourceAssetId, locked: entry.locked, entry })),
              );
            }
          }));
        } catch (error) {
          if (error instanceof PreservationPackageError) {
            await this.recordUnreadable(found, operation.id, error.code);
            await this.finish(
              operation.id,
              claimToken,
              { ...result, phase: 'done', status: 'unreadable', reasonKey: error.code },
              0,
            );
            return;
          }
          throw error;
        }

        const names = await source.listEntries();
        result.unexpected = names.filter((name) => !expectedNames.has(name)).length;
        result.phase = 'files';
      }

      const initial = await this.repository.countVerified(found.id);
      let done = Object.entries(initial)
        .filter(([state]) => state !== 'unchecked')
        .reduce((sum, [, count]) => sum + count, 0);
      const total = Object.values(initial).reduce((sum, count) => sum + count, 0);
      if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
        return;
      }

      let after: string | null = null;
      for (;;) {
        const page: PreservationItem[] = await this.repository.verificationWork(found.id, after, PAGE);
        if (page.length === 0) {
          break;
        }
        for (const item of page) {
          after = item.id;
          const parsed = PreservationEntrySchema.safeParse(item.entry);
          const state = parsed.success ? await this.checkItem(source, parsed.data) : 'changed';
          await this.repository.setVerifyState(
            item.id,
            state,
            state === 'ok' ? null : state === 'missing' ? 'package_entry_missing' : 'package_entry_changed',
          );
          done++;
          if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
            return;
          }
        }
      }

      const counts = await this.repository.countVerified(found.id);
      const verification: PreservationVerification = {
        status: verificationStatus({
          missing: counts.missing ?? 0,
          changed: counts.changed ?? 0,
          unexpected: result.unexpected,
          documentsChanged: result.documentsChanged.length,
        }),
        reasonKey: null,
        checked: (counts.ok ?? 0) + (counts.missing ?? 0) + (counts.changed ?? 0),
        ok: counts.ok ?? 0,
        missing: counts.missing ?? 0,
        changed: counts.changed ?? 0,
        unexpected: result.unexpected,
        documentsChanged: result.documentsChanged,
        operationId: operation.id,
        finishedAt: new Date().toISOString(),
      };
      await this.repository.updatePackage(found.id, {
        verification,
        verifiedAt: new Date(),
        ...(found.origin !== 'export' && { status: this.readStatus(found) }),
      });
      await this.finish(operation.id, claimToken, { ...result, phase: 'done', ...verification }, done);
    } finally {
      await source.close();
    }
  }

  /** A package from elsewhere is ready once read; one its writer did not finish says so. */
  private readStatus(found: PreservationPackage) {
    return asRecord(found.manifest).complete === false ? 'incomplete' : 'ready';
  }

  private async recordUnreadable(found: PreservationPackage, operationId: string, reasonKey: string) {
    const verification: PreservationVerification = {
      status: 'unreadable',
      reasonKey,
      checked: 0,
      ok: 0,
      missing: 0,
      changed: 0,
      unexpected: 0,
      documentsChanged: [],
      operationId,
      finishedAt: new Date().toISOString(),
    };
    await this.repository.updatePackage(found.id, {
      verification,
      verifiedAt: new Date(),
      ...(found.origin !== 'export' && { status: 'unreadable' }),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Review                                                               */
  /* ------------------------------------------------------------------ */

  private async runReview({ operation, claimToken }: RunningJob, restoreId: string): Promise<void> {
    const { restore, found } = await this.restoreContext(operation, restoreId);
    const options = asRecord(restore.options);
    const previous = asRecord(operation.result);
    const result = { phase: 'reading', restoreId: restore.id, packageId: found.id };

    const source = await this.files.openPackage(found.format, found.path);
    try {
      if (previous.phase !== 'items') {
        if (!(await this.checkpoint(operation.id, claimToken, result, 0, 0))) {
          return;
        }
        try {
          const manifest = await this.readManifest(source);
          const albums =
            (await this.readCollection(source, manifest, PRESERVATION_ALBUMS_ENTRY, PreservationAlbumsSchema)) ?? [];
          orderPreservationAlbums(albums);
          const people =
            (await this.readCollection(source, manifest, PRESERVATION_PEOPLE_ENTRY, PreservationPeopleSchema)) ?? [];
          const tags =
            (await this.readCollection(source, manifest, PRESERVATION_TAGS_ENTRY, PreservationTagsSchema)) ?? [];
          await this.readIndex(source, manifest, (entries) =>
            this.repository.addRestoreItems(
              restore.id,
              entries.map((entry) => ({ sourceAssetId: entry.sourceAssetId, locked: entry.locked, entry })),
            ),
          );
          await this.repository.updateRestore(restore.id, {
            packageIdentity: manifest.packageId,
            summary: {
              albums: albums.length,
              people: people.length,
              tags: tags.length,
              includeMetadata: manifest.scope.includeMetadata,
              packageCreatedAt: manifest.createdAt,
              // What was reviewed is what may be applied: restore compares these digests (FL-74).
              reviewedDocuments: manifest.files,
            },
          });
        } catch (error) {
          if (error instanceof PreservationPackageError) {
            await this.repository.updateRestore(restore.id, {
              status: 'unreadable',
              summary: { ...asRecord(restore.summary), reasonKey: error.code },
            });
            await this.finish(operation.id, claimToken, { ...result, phase: 'done', reasonKey: error.code }, 0);
            return;
          }
          throw error;
        }
        result.phase = 'items';
      }

      const counts = await this.repository.countRestoreItems(restore.id);
      let done = counts.total - counts.pending;
      const total = counts.total;
      if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
        return;
      }

      let after: string | null = null;
      for (;;) {
        const page: PreservationRestoreItem[] = await this.repository.reviewWork(restore.id, after, PAGE);
        if (page.length === 0) {
          break;
        }
        for (const item of page) {
          after = item.id;
          await this.reviewItem(restore.ownerId, source, item, options.restoreEditRecipes !== false);
          done++;
          if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
            return;
          }
        }
      }

      await this.repository.updateRestore(restore.id, { status: 'ready' });
      await this.finish(operation.id, claimToken, { ...result, phase: 'done' }, done);
    } finally {
      await source.close();
    }
  }

  /** Verify one item and find what the library holds for it. Nothing in the library is written. */
  private async reviewItem(
    ownerId: string,
    source: PreservationPackageSource,
    item: PreservationRestoreItem,
    restoreEditRecipes: boolean,
  ): Promise<void> {
    const entry = PreservationEntrySchema.safeParse(item.entry);
    if (!entry.success) {
      await this.repository.updateRestoreItem(item.id, { state: 'failed', reasonKey: 'package_index_invalid' });
      return;
    }

    let sidecar: PreservationSidecar | null = null;
    if (entry.data.metadata) {
      try {
        const bytes = await source.readDocument(entry.data.metadata.path, PRESERVATION_MAX_SIDECAR_BYTES);
        if (!matchesDigest(bytes, entry.data.metadata)) {
          await this.repository.updateRestoreItem(item.id, { state: 'failed', reasonKey: 'metadata_changed' });
          return;
        }
        const checked = checkPreservationJson(PreservationSidecarSchema, bytes);
        if (
          !checked.ok ||
          checked.value.sourceAssetId !== entry.data.sourceAssetId ||
          checked.value.checksum.sha256 !== entry.data.original.sha256 ||
          checked.value.checksum.sha1 !== entry.data.original.sha1
        ) {
          await this.repository.updateRestoreItem(item.id, { state: 'failed', reasonKey: 'metadata_invalid' });
          return;
        }
        sidecar = checked.value;
      } catch (error) {
        if (!(error instanceof PreservationPackageError)) {
          throw error;
        }
        await this.repository.updateRestoreItem(item.id, { state: 'failed', reasonKey: 'metadata_missing' });
        return;
      }
    }

    const state = await this.checkItem(source, { ...entry.data, metadata: null });
    if (state !== 'ok') {
      await this.repository.updateRestoreItem(item.id, {
        state: 'failed',
        reasonKey: state === 'missing' ? 'original_missing' : 'original_changed',
      });
      return;
    }

    const rows = await this.repository.findByChecksum(ownerId, entry.data.original.sha256, entry.data.original.sha1);
    const live = rows.find((row) => !row.deletedAt);
    const trashed = rows.find((row) => row.deletedAt);
    let conflicts: Record<string, unknown>[] = [];
    if (live && sidecar) {
      const library = await this.repository.getLibraryState(live.id);
      if (library) {
        conflicts = compareWithLibrary(sidecar, library, { restoreEditRecipes }).conflicts;
      }
    }
    await this.repository.updateRestoreItem(item.id, {
      state: 'ready',
      match: live ? 'existing' : trashed ? 'trashed' : 'new',
      assetId: live?.id ?? trashed?.id ?? null,
      sidecar: sidecar as unknown as Record<string, unknown> | null,
      conflicts,
      reasonKey: live || !trashed ? null : 'asset_in_trash',
    });
  }

  /* ------------------------------------------------------------------ */
  /* Restore                                                              */
  /* ------------------------------------------------------------------ */

  private async runRestore({ operation, claimToken }: RunningJob, restoreId: string): Promise<void> {
    const { restore, found } = await this.restoreContext(operation, restoreId);
    if (!['ready', 'restoring', 'completed'].includes(restore.status)) {
      throw new PreservationPackageError('restore_not_reviewed', 'The package has not been reviewed');
    }
    const auth = await this.ownerAuth(restore.ownerId);
    if (!auth) {
      throw new PreservationPackageError(
        'owner_unavailable',
        'The account that asked for this restoration no longer exists',
      );
    }
    await this.repository.updateRestore(restore.id, { status: 'restoring' });

    const options = asRecord(restore.options);
    const previous = asRecord(operation.result);
    const result = {
      phase: 'restoring',
      restoreId: restore.id,
      packageId: found.id,
      restored: typeof previous.restored === 'number' ? previous.restored : 0,
      matched: typeof previous.matched === 'number' ? previous.matched : 0,
      failed: typeof previous.failed === 'number' ? previous.failed : 0,
      editWaits: typeof previous.editWaits === 'number' ? previous.editWaits : 0,
    };

    const source = await this.files.openPackage(found.format, found.path);
    try {
      const manifest = await this.readManifest(source);
      const identity = restore.packageIdentity ?? manifest.packageId;
      // A restoration reviewed before digests were recorded (FL-74) carries none; it is compared with
      // the digests stored on the package row when there are some, and is otherwise not refused for
      // a comparison its review never made possible.
      const reviewedDocuments =
        asRecord(restore.summary).reviewedDocuments ?? asRecord(found.manifest).files ?? manifest.files;
      if (identity !== manifest.packageId || !sameReviewedDocuments(reviewedDocuments, manifest.files)) {
        // A package rewritten in place since its review is never applied as changed; it is reviewed again.
        const reasonKey = 'package_changed_since_review';
        await this.repository.updateRestore(restore.id, {
          status: 'unreadable',
          summary: { ...asRecord(restore.summary), reasonKey },
        });
        await this.finish(operation.id, claimToken, { ...result, phase: 'done', reasonKey }, 0);
        this.logger.warn(`Preservation restore ${restore.id} refused: the package changed after it was reviewed`);
        return;
      }
      const albums =
        (await this.readCollection(source, manifest, PRESERVATION_ALBUMS_ENTRY, PreservationAlbumsSchema)) ?? [];
      const people =
        (await this.readCollection(source, manifest, PRESERVATION_PEOPLE_ENTRY, PreservationPeopleSchema)) ?? [];

      const context: RestoreContext = {
        auth,
        ownerId: restore.ownerId,
        restore,
        source,
        albums: await this.ensureAlbums(restore.ownerId, identity, albums),
        people: await this.ensurePeople(restore.ownerId, identity, people),
        restoreEditRecipes: options.restoreEditRecipes !== false,
        conflictDefault: options.conflictDefault === 'replace' ? 'replace' : 'keep',
      };

      let done = 0;
      let total = await this.repository.countRestoreWork(restore.id, PRESERVATION_ITEM_ATTEMPTS);
      if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
        return;
      }
      for (let pass = 0; pass < PRESERVATION_ITEM_ATTEMPTS; pass++) {
        if (pass > 0) {
          total = done + (await this.repository.countRestoreWork(restore.id, PRESERVATION_ITEM_ATTEMPTS));
        }
        let after: string | null = null;
        for (;;) {
          const page: PreservationRestoreItem[] = await this.repository.restoreWork(
            restore.id,
            after,
            PAGE,
            PRESERVATION_ITEM_ATTEMPTS,
          );
          if (page.length === 0) {
            break;
          }
          for (const item of page) {
            after = item.id;
            const outcome = await this.restoreItem(context, item);
            result[outcome]++;
            done++;
            if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
              return;
            }
          }
        }
      }

      result.phase = 'relationships';
      if (!(await this.checkpoint(operation.id, claimToken, result, done, total))) {
        return;
      }
      await this.restoreRelationships(context);

      // Edit recipes of new originals wait for their dimensions, which metadata extraction measures.
      const waiting = await this.applyWaitingEdits(context, result.editWaits >= PRESERVATION_EDIT_WAITS);
      if (waiting > 0) {
        result.phase = 'waiting-for-metadata';
        result.editWaits++;
        const written = await this.operations.setBulkResult(operation.id, claimToken, {
          result,
          processedUnits: done,
          totalUnits: total,
          progress: preservationProgress(done, total),
          leaseMs: PRESERVATION_LEASE_MS,
        });
        if (
          written &&
          (await this.operations.requeue(operation.id, claimToken, { delayMs: PRESERVATION_EDIT_WAIT_MS }))
        ) {
          return;
        }
        if (written && (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt)) {
          await this.operations.acknowledgeCancel(operation.id, claimToken, { released: false });
        }
        return;
      }

      const counts = await this.repository.countRestoreItems(restore.id);
      await this.repository.updateRestore(restore.id, {
        status: 'completed',
        summary: { ...asRecord((await this.repository.getRestoreById(restore.id))?.summary), counts },
      });
      await this.finish(operation.id, claimToken, { ...result, phase: 'done' }, done);
      this.logger.log(
        `Preservation restore ${restore.id} finished: ${counts.restored} restored, ${counts.matched} matched, ${counts.failed} failed`,
      );
    } finally {
      await source.close();
    }
  }

  /**
   * Restore one original. It is matched when the library already holds the bytes, and added only
   * when it does not; an existing original is never replaced and a second copy is never made. The
   * intent to add is recorded before the upload, so a retry after a crash recognizes the asset it
   * made instead of treating it as one the owner already had.
   */
  private async restoreItem(
    context: RestoreContext,
    item: PreservationRestoreItem,
  ): Promise<'restored' | 'matched' | 'failed'> {
    await this.repository.updateRestoreItem(item.id, { attempt: true });
    try {
      const entry = PreservationEntrySchema.parse(item.entry);
      const sidecar = item.sidecar ? PreservationSidecarSchema.parse(item.sidecar) : null;
      const locked = entry.locked || !!sidecar?.lock;

      let assetId: string | null = null;
      let created = false;
      const rows = await this.repository.findByChecksum(context.ownerId, entry.original.sha256, entry.original.sha1);
      const live = rows.find((row) => !row.deletedAt);
      if (live) {
        assetId = live.id;
        // Added by an earlier attempt of this item (it recorded the intent first), not one the owner had.
        created = !!item.creatingAt && new Date(live.createdAt).getTime() >= new Date(item.creatingAt).getTime() - 1000;
      } else if (rows.some((row) => row.deletedAt)) {
        throw new PreservationPackageError(
          'asset_in_trash',
          'The library holds this original in the trash; restore it from the trash first',
        );
      }

      if (!assetId) {
        await this.repository.updateRestoreItem(item.id, { state: 'creating', creatingAt: new Date() });
        const destination = StorageCore.getNestedPath(
          StorageFolder.Upload,
          context.ownerId,
          `${randomUUID()}${extname(entry.original.path)}`,
        );
        await this.files.extractVerified(context.source, entry.original.path, destination, {
          sha1: entry.original.sha1,
          sha256: entry.original.sha256,
          bytes: entry.original.bytes,
        });
        const response = await this.assetMedia.uploadAsset(
          context.auth,
          {
            filename: entry.originalFileName,
            fileCreatedAt: new Date(sidecar?.dates.fileCreatedAt ?? Date.now()),
            fileModifiedAt: new Date(sidecar?.dates.fileModifiedAt ?? Date.now()),
            isFavorite: sidecar?.isFavorite ?? false,
            // Locked from the first moment it exists: never listed unlocked, not even for an instant.
            visibility: locked
              ? AssetVisibility.Locked
              : sidecar?.visibility === 'hidden'
                ? AssetVisibility.Hidden
                : AssetVisibility.Timeline,
          },
          {
            uuid: randomUUID(),
            checksum: Buffer.from(entry.original.sha256, 'hex'),
            legacyChecksum: Buffer.from(entry.original.sha1, 'hex'),
            originalPath: destination,
            originalName: entry.originalFileName,
            size: entry.original.bytes,
          },
        );
        if (response.status === AssetMediaStatus.DUPLICATE && /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(response.id)) {
          throw new PreservationPackageError(
            'asset_hidden',
            'The library holds this original where it cannot be matched',
          );
        }
        assetId = response.id;
        created = response.status === AssetMediaStatus.CREATED;
      }

      await this.repository.updateRestoreItem(item.id, { assetId, match: created ? 'new' : 'existing' });
      const findings = sidecar ? await this.applyMetadata(context, item, assetId, created, sidecar) : [];
      if (!sidecar && locked) {
        await this.lock(context, assetId, 'marked');
      }

      await this.repository.updateRestoreItem(item.id, {
        state: created ? 'restored' : 'matched',
        appliedAt: new Date(),
        findings,
        reasonKey: null,
        error: null,
      });
      return created ? 'restored' : 'matched';
    } catch (error) {
      const reasonKey = codeOf(error, 'restore_failed');
      await this.repository.updateRestoreItem(item.id, { state: 'failed', reasonKey, error: describe(error) });
      if (reasonKey === 'package_no_space') {
        throw error;
      }
      return 'failed';
    }
  }

  /**
   * Apply a sidecar to a restored or matched original, by the owner's choices. Returns what the
   * owner should know about: provenance kept rather than applied, and anything that could not be.
   */
  private async applyMetadata(
    context: RestoreContext,
    item: PreservationRestoreItem,
    assetId: string,
    created: boolean,
    sidecar: PreservationSidecar,
  ): Promise<string[]> {
    const findings: string[] = [];
    const library = await this.repository.getLibraryState(assetId);
    if (!library) {
      throw new PreservationPackageError('asset_unavailable', 'The restored original is gone');
    }
    const comparison = created
      ? null
      : compareWithLibrary(sidecar, library, { restoreEditRecipes: context.restoreEditRecipes });
    const fields = fieldsToRestore({
      created,
      comparison,
      decisions: sanitizeDecisions(item.decisions),
      conflictDefault: context.conflictDefault,
      restoreEditRecipes: context.restoreEditRecipes,
    });

    const patch: UpdateAssetDto = {};
    if (fields.has('date') && sidecar.dates.dateTimeOriginal) {
      patch.dateTimeOriginal = sidecar.dates.dateTimeOriginal;
    }
    const description = manualDescription(sidecar);
    if (fields.has('description') && description) {
      // The library's own generated paragraphs stay: they were not the package's to replace.
      const kept = splitDescription(library.description).generated.map(
        (text) => `${GENERATED_DESCRIPTION_MARK} ${text}`,
      );
      patch.description = [description, ...kept].join('\n\n');
    }
    if (fields.has('location') && sidecar.location) {
      patch.latitude = sidecar.location.latitude;
      patch.longitude = sidecar.location.longitude;
    }
    const rating = restorableRating(sidecar.rating);
    if (fields.has('rating') && rating !== null) {
      patch.rating = rating;
    }
    if (fields.has('favorite') && sidecar.isFavorite && !library.isFavorite) {
      patch.isFavorite = true;
    }
    if (
      fields.has('archive') &&
      (sidecar.visibility === 'archive' || sidecar.visibility === 'timeline') &&
      library.visibility !== sidecar.visibility &&
      library.visibility !== AssetVisibility.Hidden
    ) {
      patch.visibility = sidecar.visibility === 'archive' ? AssetVisibility.Archive : AssetVisibility.Timeline;
    }
    if (Object.keys(patch).length > 0) {
      await this.assets.update(context.auth, assetId, patch);
    }

    // Locked in the package is Locked in the library, whatever else was chosen; nothing is unlocked.
    if (sidecar.lock) {
      if (!library.locked) {
        await this.lock(context, assetId, sidecar.lock.reason);
      } else if (created) {
        await this.repository.setLockReason(assetId, sidecar.lock.reason);
      }
    }

    if (fields.has('editRecipe') && sidecar.edits.recipe.length > 0) {
      const outcome = await this.applyRecipe(context.auth, assetId, sidecar);
      if (outcome !== 'applied') {
        findings.push(outcome);
      }
    }

    for (const sourceAlbumId of sidecar.albums) {
      const albumId = context.albums.get(sourceAlbumId);
      if (!albumId) {
        findings.push('album_not_restored');
        continue;
      }
      await this.albums.addAssets(context.auth, albumId, { ids: [assetId] });
    }

    if (sidecar.tags.length > 0) {
      const tags = await upsertTags(this.tagRepository, { userId: context.ownerId, tags: sidecar.tags });
      await this.tagRepository.upsertAssetIds(tags.map((tag) => ({ tagId: tag.id, assetId })));
    }

    if (sidecar.faces.length > 0) {
      findings.push(...(await this.applyFaces(context, assetId, sidecar)));
    }

    let documentsKept = 0;
    for (const document of sidecar.documents) {
      if (!(await this.repository.addDocumentEdit(assetId, context.ownerId, document))) {
        documentsKept++;
      }
    }
    if (documentsKept > 0) {
      findings.push('document_corrections_kept');
    }

    if (sidecar.type === 'VIDEO') {
      for (const moment of sidecar.moments.manual) {
        await this.repository.addManualMoment(assetId, context.ownerId, moment);
      }
    }

    const provenance = asRecord(sidecar.provenance);
    if (
      sidecar.description?.source === 'generated' ||
      (Array.isArray(provenance.generatedDescriptions) && provenance.generatedDescriptions.length > 0)
    ) {
      findings.push('generated_description_provenance');
    }
    if (sidecar.moments.generated.length > 0) {
      findings.push('generated_moments_provenance');
    }
    if (comparison?.conflicts.some((conflict) => !fields.has(conflict.field))) {
      findings.push('library_values_kept');
    }
    return findings;
  }

  /** Lock through the asset service, which releases covers, then keep the package's reason. */
  private async lock(context: RestoreContext, assetId: string, reason: string) {
    await this.assets.update(context.auth, assetId, { visibility: AssetVisibility.Locked });
    if (reason !== AssetLockReason.Marked) {
      await this.repository.setLockReason(assetId, reason);
    }
  }

  /**
   * Apply an edit recipe through the editing service, which validates it against the original and
   * renders the edited version. A new original has no dimensions until its metadata is read, so its
   * recipe waits for that rather than being refused.
   */
  private async applyRecipe(auth: AuthDto, assetId: string, sidecar: PreservationSidecar): Promise<string> {
    const parsed = AssetEditsCreateDto.schema.safeParse({ edits: sidecar.edits.recipe });
    if (!parsed.success) {
      return 'edit_recipe_unsupported';
    }
    const current = await this.repository.getEditRecipe(assetId);
    if (
      canonicalJson(current.map(({ action, parameters }) => ({ action, parameters }))) ===
      canonicalJson(sidecar.edits.recipe)
    ) {
      return 'applied';
    }
    try {
      await this.assets.editAsset(auth, assetId, parsed.data as AssetEditsCreateDto);
      return 'applied';
    } catch (error) {
      if (error instanceof BadRequestException && /not available for editing/.test(error.message)) {
        return FINDING_EDIT_WAITING;
      }
      if (error instanceof BadRequestException) {
        return 'edit_recipe_unsupported';
      }
      throw error;
    }
  }

  /**
   * Named people come back on their faces. A face the library already has in the same place keeps
   * its person if it has one and is given the package's if it has none; a face the library lacks is
   * added. Face detection later matches these regions instead of making new ones.
   */
  private async applyFaces(context: RestoreContext, assetId: string, sidecar: PreservationSidecar): Promise<string[]> {
    const findings = new Set<string>();
    const existing = await this.repository.getFaces(assetId);
    for (const face of sidecar.faces) {
      const personGroupId = context.people.get(face.personId);
      if (!personGroupId) {
        findings.add('person_not_restored');
        continue;
      }
      const region = {
        x1: face.x1,
        y1: face.y1,
        x2: face.x2,
        y2: face.y2,
        width: face.imageWidth,
        height: face.imageHeight,
      };
      const match = existing.find(
        (candidate) =>
          candidate.imageWidth > 0 &&
          candidate.imageHeight > 0 &&
          overlap(region, {
            x1: candidate.boundingBoxX1,
            y1: candidate.boundingBoxY1,
            x2: candidate.boundingBoxX2,
            y2: candidate.boundingBoxY2,
            width: candidate.imageWidth,
            height: candidate.imageHeight,
          }) > 0.5,
      );
      if (match) {
        if (!match.personGroupId) {
          await this.repository.nameFace(match.id, personGroupId);
        } else if (match.personGroupId !== personGroupId) {
          findings.add('face_named_differently');
        }
        continue;
      }
      await this.repository.addFace({ assetId, personGroupId, ...face });
    }
    return [...findings];
  }

  /**
   * Live Photo pairs and stacks, once both halves or every member have a place in the library. An
   * existing pairing or stack is kept as it is; the package never breaks up what the owner has.
   */
  private async restoreRelationships(context: RestoreContext) {
    const stacks = new Map<string, { primary: string; members: Map<string, string> }>();
    let after: string | null = null;
    for (;;) {
      const page: PreservationRestoreItem[] = await this.repository.appliedItems(context.restore.id, after, 500);
      if (page.length === 0) {
        break;
      }
      for (const item of page) {
        after = item.id;
        const sidecar = PreservationSidecarSchema.safeParse(item.sidecar);
        if (!sidecar.success || !item.assetId) {
          continue;
        }
        if (sidecar.data.livePhotoVideoId) {
          await this.linkLivePhoto(context, item, item.assetId, sidecar.data.livePhotoVideoId);
        }
        if (sidecar.data.stack) {
          const group = stacks.get(sidecar.data.stack.id) ?? {
            primary: sidecar.data.stack.primaryAssetId,
            members: new Map<string, string>(),
          };
          group.members.set(item.sourceAssetId, item.assetId);
          stacks.set(sidecar.data.stack.id, group);
        }
      }
    }

    for (const group of stacks.values()) {
      if (group.members.size < 2) {
        continue;
      }
      const assetIds = group.members.values().toArray();
      const current = await Promise.all(assetIds.map((id) => this.repository.getOwnedAsset(id, context.ownerId)));
      if (current.some((asset) => !asset || asset.deletedAt || asset.stackId)) {
        continue;
      }
      const primary = group.members.get(group.primary);
      const ordered = primary ? [primary, ...assetIds.filter((id) => id !== primary)] : assetIds;
      try {
        await this.stacks.create(context.auth, { assetIds: ordered });
      } catch (error) {
        this.logger.warn(
          `Preservation restore ${context.restore.id}: a stack could not be restored: ${describe(error)}`,
        );
      }
    }
  }

  private async linkLivePhoto(
    context: RestoreContext,
    item: PreservationRestoreItem,
    photoId: string,
    sourceMotionId: string,
  ) {
    const motion = await this.repository.getRestoreItemBySource(context.restore.id, sourceMotionId);
    const photo = await this.repository.getOwnedAsset(photoId, context.ownerId);
    if (!photo || !motion?.assetId || !motion.appliedAt) {
      await this.addFinding(item, 'live_photo_incomplete');
      return;
    }
    if (photo.livePhotoVideoId === motion.assetId) {
      return;
    }
    if (photo.livePhotoVideoId) {
      await this.addFinding(item, 'live_photo_kept');
      return;
    }
    try {
      await this.assets.update(context.auth, photoId, { livePhotoVideoId: motion.assetId });
    } catch (error) {
      this.logger.warn(
        `Preservation restore ${context.restore.id}: a Live Photo could not be paired: ${describe(error)}`,
      );
      await this.addFinding(item, 'live_photo_incomplete');
    }
  }

  private async addFinding(item: PreservationRestoreItem, finding: string) {
    const findings = Array.isArray(item.findings) ? item.findings : [];
    if (!findings.includes(finding)) {
      await this.repository.updateRestoreItem(item.id, { findings: [...findings, finding] });
    }
  }

  /**
   * Try again the edit recipes that were waiting for their original's metadata. Returns how many
   * still wait; when `giveUp` is set they are reported as not applied instead.
   */
  private async applyWaitingEdits(context: RestoreContext, giveUp: boolean): Promise<number> {
    let waiting = 0;
    let after: string | null = null;
    for (;;) {
      const page: PreservationRestoreItem[] = await this.repository.restoreItemsWithFinding(
        context.restore.id,
        FINDING_EDIT_WAITING,
        after,
        PAGE,
      );
      if (page.length === 0) {
        return waiting;
      }
      for (const item of page) {
        after = item.id;
        const sidecar = PreservationSidecarSchema.safeParse(item.sidecar);
        if (!sidecar.success || !item.assetId) {
          continue;
        }
        const outcome = await this.applyRecipe(context.auth, item.assetId, sidecar.data);
        const others = (item.findings ?? []).filter((finding) => finding !== FINDING_EDIT_WAITING);
        if (outcome === FINDING_EDIT_WAITING && !giveUp) {
          waiting++;
          continue;
        }
        const next =
          outcome === 'applied'
            ? others
            : [...others, outcome === FINDING_EDIT_WAITING ? 'edit_recipe_not_applied' : outcome];
        await this.repository.updateRestoreItem(item.id, { findings: next });
      }
    }
  }

  /**
   * Albums and collections for a restoration, parents first, and where each one of the package
   * lands. Nothing is created twice: the package's own album when it is still the owner's (a
   * restore on the server that wrote it), then one this or an earlier restoration of the same
   * package created, then the owner's only album with the same name in the same place. Only then a
   * new one, with an id derived from the package, so a retry finds it.
   */
  private async ensureAlbums(
    ownerId: string,
    identity: string,
    albums: PreservationAlbum[],
  ): Promise<Map<string, string>> {
    const mapped = new Map<string, string>();
    const byId = new Map(albums.map((album) => [album.id, album]));
    for (const album of orderPreservationAlbums(albums)) {
      const sourceParent = restoredAlbumParent(album, byId);
      const parentId = sourceParent ? (mapped.get(sourceParent) ?? null) : null;

      const same = await this.repository.getOwnedAlbum(ownerId, album.id);
      if (same && same.kind === album.kind) {
        mapped.set(album.id, same.id);
        continue;
      }
      const derived = preservationDerivedId(`${ownerId}:album:${identity}:${album.id}`);
      if (await this.repository.getOwnedAlbum(ownerId, derived)) {
        mapped.set(album.id, derived);
        continue;
      }
      const named = await this.repository.findOwnedAlbumsByName(ownerId, album.name, album.kind, parentId);
      if (named.length === 1) {
        mapped.set(album.id, named[0].id);
        continue;
      }
      if (await this.repository.albumExists(derived)) {
        // Taken by something that is not the owner's: never written to, and the album is reported missing.
        continue;
      }
      await this.albumRepository.create(
        {
          id: derived,
          albumName: album.name || 'Untitled',
          description: album.description,
          kind: album.kind === 'collection' ? AlbumKind.Collection : AlbumKind.Album,
          parentId,
          icon: album.icon,
          ...(album.order && { order: album.order === 'asc' ? AssetOrder.Asc : AssetOrder.Desc }),
        },
        [],
        [{ userId: ownerId, role: AlbumUserRole.Owner }],
        ownerId,
      );
      mapped.set(album.id, derived);
    }
    return mapped;
  }

  /** People for a restoration, found or created the same way as albums. */
  private async ensurePeople(
    ownerId: string,
    identity: string,
    people: PreservationPerson[],
  ): Promise<Map<string, string>> {
    const mapped = new Map<string, string>();
    for (const person of people) {
      if (await this.repository.getOwnedPerson(ownerId, person.id)) {
        mapped.set(person.id, person.id);
        continue;
      }
      const derived = preservationDerivedId(`${ownerId}:person:${identity}:${person.id}`);
      if (await this.repository.getOwnedPerson(ownerId, derived)) {
        mapped.set(person.id, derived);
        continue;
      }
      if (person.name) {
        const named = await this.repository.findPeopleByName(ownerId, person.name);
        if (named.length === 1) {
          mapped.set(person.id, named[0].personGroupId);
          continue;
        }
      }
      await this.repository.createPerson(ownerId, derived, {
        name: person.name,
        birthDate: person.birthDate,
        isHidden: person.isHidden,
        isFavorite: person.isFavorite,
        color: person.color,
      });
      if (await this.repository.getOwnedPerson(ownerId, derived)) {
        mapped.set(person.id, derived);
      }
    }
    return mapped;
  }

  /* ------------------------------------------------------------------ */
  /* Shared machinery                                                     */
  /* ------------------------------------------------------------------ */

  private async restoreContext(operation: MediaOperation, restoreId: string) {
    const restore = await this.repository.getRestoreById(restoreId);
    if (!restore || restore.ownerId !== operation.ownerId || !restore.packageId) {
      throw new PreservationPackageError('restore_unavailable', 'The restoration is gone');
    }
    const found = await this.repository.getPackageById(restore.packageId);
    if (!found || found.ownerId !== operation.ownerId || found.removedAt) {
      throw new PreservationPackageError('package_unavailable', 'The package is gone');
    }
    return { restore, found };
  }

  /**
   * Record progress and learn about a cancel or a pause in the same round trip. False means stop:
   * the claim was lost, the owner cancelled (acknowledged here), or the owner paused and the claim
   * has been handed back with everything recorded.
   */
  private async checkpoint(
    id: string,
    claimToken: string,
    result: Record<string, unknown>,
    done: number,
    total: number,
  ): Promise<boolean> {
    const written = await this.operations.setBulkResult(id, claimToken, {
      result,
      processedUnits: done,
      totalUnits: Math.max(total, done),
      progress: preservationProgress(done, Math.max(total, done)),
      leaseMs: PRESERVATION_LEASE_MS,
    });
    if (!written) {
      this.logger.warn(`Preservation job ${id}: claim lost, stopping`);
      return false;
    }
    if (written.status === MediaOperationStatus.Cancelling || written.cancelRequestedAt) {
      await this.operations.acknowledgeCancel(id, claimToken, { released: false });
      this.logger.log(`Preservation job ${id} cancelled by its owner`);
      return false;
    }
    if (written.pauseRequestedAt && (await this.operations.settlePause(id, claimToken))) {
      this.logger.log(`Preservation job ${id} paused by its owner`);
      return false;
    }
    if (written.status === MediaOperationStatus.Preparing) {
      await this.operations.reportProgress(id, claimToken, {
        status: MediaOperationStatus.Rendering,
        processedUnits: done,
        totalUnits: Math.max(total, done),
        progress: preservationProgress(done, Math.max(total, done)),
      });
    }
    return true;
  }

  /** Publish the result. A cancel that arrived at the last moment is acknowledged instead. */
  private async finish(id: string, claimToken: string, result: Record<string, unknown>, total: number) {
    const written = await this.operations.setBulkResult(id, claimToken, {
      result,
      processedUnits: total,
      totalUnits: total,
      progress: 100,
      leaseMs: PRESERVATION_LEASE_MS,
    });
    if (!written) {
      throw new PreservationPackageError('preservation_claim_lost', 'The job was taken over before it could finish');
    }
    if (await this.operations.beginValidation(id, claimToken)) {
      await this.operations.complete(id, claimToken, { resultAssetId: null });
      return true;
    }
    await this.operations.acknowledgeCancel(id, claimToken, { released: false });
    return false;
  }

  /**
   * The owner, acting through the worker as a background runner (owner decision, September 22,
   * 2026): elevated, so it can restore Locked media and lock what the package says is Locked.
   * Nothing it reads is shown to anybody; what the package may contain was decided at submit.
   */
  private async ownerAuth(ownerId: string): Promise<AuthDto | null> {
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
      session: { id: this.sessionId, hasElevatedPermission: true },
    };
  }
}
