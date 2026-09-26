import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { basename } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { OnEvent } from 'src/decorators.js';
import { MediaOperationDto } from 'src/dtos/media-operation.dto.js';
import {
  PreservationDecisionsUpdateDto,
  PreservationExportCreateDto,
  PreservationItemDto,
  PreservationItemsQueryDto,
  PreservationItemsResponseDto,
  PreservationPackageDto,
  PreservationPreviewDto,
  PreservationPreviewResponseDto,
  PreservationRestoreCreateDto,
  PreservationRestoreDto,
  PreservationRestoreItemDto,
  PreservationRestoreItemsQueryDto,
  PreservationRestoreItemsResponseDto,
  PreservationServerPackageCreateDto,
  PreservationSupport,
} from 'src/dtos/preservation.dto.js';
import { MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PreservationFileRepository } from 'src/repositories/preservation-files.repository.js';
import {
  PreservationItem,
  PreservationPackage,
  PreservationRepository,
  PreservationRestore,
  PreservationRestoreItem,
  PreservationSelection,
} from 'src/repositories/preservation.repository.js';
import { ImmichReadStream, StorageRepository } from 'src/repositories/storage.repository.js';
import { mapOperation } from 'src/services/media-operation.service.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { isActiveMediaOperation } from 'src/utils/media-operation.js';
import {
  PRESERVATION_CONFLICT_FIELDS,
  PRESERVATION_DESTINATION,
  PRESERVATION_INDEX_ENTRY,
  PRESERVATION_MANIFEST_ENTRY,
  PRESERVATION_MAX_ITEMS,
  PRESERVATION_MAX_MANIFEST_BYTES,
  PRESERVATION_SUPPORT,
  PRESERVATION_SUPPORT_CATEGORIES,
  PRESERVATION_UPLOAD_MAX_BYTES,
  PRESERVATION_UPLOAD_TTL_HOURS,
  PreservationConflict,
  PreservationManifestSchema,
  PreservationPackageError,
  PreservationSupportCategory,
  PreservationSupportLevel,
  checkPreservationJson,
  describePreservationScope,
  preservationFileName,
  sanitizeDecisions,
} from 'src/utils/preservation.js';

const asIso = (value: Date | string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asInt = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0);

const asText = (value: unknown) => (typeof value === 'string' ? value : null);

const hoursFrom = (now: Date, hours: number) => new Date(now.getTime() + hours * 60 * 60 * 1000);

/** Categories that only travel with metadata sidecars. Originals and their checksums always travel. */
const METADATA_CATEGORIES = new Set<PreservationSupportCategory>(
  PRESERVATION_SUPPORT_CATEGORIES.filter((category) => category !== 'originals'),
);

/**
 * What a restoration from this package does with each kind of information, as this server does it.
 * A package written without metadata carries only its originals.
 */
export const preservationSupportFor = (includeMetadata: boolean): PreservationSupport[] =>
  PRESERVATION_SUPPORT_CATEGORIES.map((category) => ({
    category,
    level:
      !includeMetadata && METADATA_CATEGORIES.has(category)
        ? ('not-included' as PreservationSupportLevel)
        : PRESERVATION_SUPPORT[category],
  }));

const packageStatuses = ['building', 'ready', 'incomplete', 'unreadable', 'removed'] as const;
const restoreStatuses = ['reviewing', 'ready', 'restoring', 'completed', 'unreadable'] as const;
const itemStates = ['pending', 'copied', 'failed', 'skipped', 'listed'] as const;
const verifyStates = ['ok', 'missing', 'changed'] as const;
const restoreItemStates = ['pending', 'ready', 'failed', 'creating', 'restored', 'matched', 'skipped'] as const;
const matches = ['new', 'existing', 'trashed'] as const;

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;

/**
 * Preservation packages (FL-74, `IMP-006`): the request side.
 *
 * A package is written, verified, reviewed and restored by durable media operations that
 * `PreservationWorkerService` runs; this service checks each request, freezes what it may touch,
 * queues the job and answers questions about packages and restorations. The rules it keeps:
 *
 * - **Your own media only.** An export selects only items the account owns — never a partner's,
 *   a shared album's or a shared space's — and every read is scoped to the owner in the query, so
 *   somebody else's package reads as absent.
 * - **Locked stays Locked.** Locked items join an export only from an unlocked session; a package
 *   that holds any is downloadable only from one; and an ordinary session is never told a Locked
 *   item exists — not its name, not its values, not even a count (owner decision, September 22,
 *   2026). The worker, a background runner, reads them all. Restored, a Locked item is Locked again.
 * - **A download is not a restore.** Every package says, category by category, what a restoration
 *   brings back, keeps as provenance or leaves out ({@link PRESERVATION_SUPPORT}).
 */
@Injectable()
export class PreservationService {
  constructor(
    private logger: LoggingRepository,
    private repository: PreservationRepository,
    private files: PreservationFileRepository,
    private operations: MediaOperationRepository,
    private storage: StorageRepository,
  ) {
    this.logger.setContext(PreservationService.name);
  }

  /* ------------------------------------------------------------------ */
  /* Exports                                                              */
  /* ------------------------------------------------------------------ */

  /** How many items a selection holds and whether it fits in one package. Writes nothing. */
  async preview(auth: AuthDto, dto: PreservationPreviewDto): Promise<PreservationPreviewResponseDto> {
    this.requireAccount(auth);
    const unlocked = this.isUnlocked(auth);
    const counts = await this.repository.previewSelection(auth.user.id, this.selectionOf(dto.scope));
    const includeLocked = dto.includeLocked === true && unlocked;
    const includedItems = counts.items + (includeLocked ? counts.lockedItems : 0);
    const includedBytes = counts.bytes + (includeLocked ? counts.lockedBytes : 0);

    let freeBytes: string | null = null;
    try {
      freeBytes = String(await this.files.freeBytes(this.files.ownerFolders(auth.user.id)[0]));
    } catch (error) {
      this.logger.warn(`Could not measure free space for preservation: ${String(error).slice(0, 200)}`);
    }

    return {
      items: counts.items,
      bytes: String(counts.bytes),
      // An ordinary session is not told how much of its library is Locked.
      lockedItems: unlocked ? counts.lockedItems : 0,
      lockedBytes: unlocked ? String(counts.lockedBytes) : '0',
      includedItems,
      includedBytes: String(includedBytes),
      maxItems: PRESERVATION_MAX_ITEMS,
      withinLimit: includedItems <= PRESERVATION_MAX_ITEMS,
      lockedAllowed: unlocked,
      freeBytes,
      support: preservationSupportFor(true),
    };
  }

  /**
   * Freeze a selection as a new package and queue the job that writes it.
   *
   * The selection is resolved now, for this session, and stored as the package's items: a later
   * change to the library does not change what the job writes, and the worker, which can read
   * more than the session could, never writes anything else.
   */
  async createExport(auth: AuthDto, dto: PreservationExportCreateDto): Promise<PreservationPackageDto> {
    this.requireAccount(auth);

    if (dto.requestKey) {
      const existing = await this.operations.getByRequestKey(
        auth.user.id,
        MediaOperationKind.PreservationExport,
        dto.requestKey,
      );
      if (existing) {
        const packageId = asText(asRecord(existing.snapshot).packageId);
        const found = packageId ? await this.repository.getPackage(packageId, auth.user.id) : undefined;
        if (!found) {
          throw new ConflictException('This request key was already used');
        }
        return this.mapPackage(auth, found);
      }
    }

    const includeLocked = dto.includeLocked === true;
    if (includeLocked && !this.isUnlocked(auth)) {
      throw new ForbiddenException('Unlock the Locked view to include Locked items in a package');
    }

    const selection = this.selectionOf(dto.scope);
    const includeMetadata = dto.includeMetadata ?? true;
    const created = await this.repository.createExport(
      {
        ownerId: auth.user.id,
        origin: 'export',
        name: dto.name,
        format: 'directory',
        includeLocked,
        includeMetadata,
        scope: {
          description: describePreservationScope(selection),
          itemCount: selection.assetIds?.length ?? null,
          filter: selection.filter ?? null,
        },
      },
      (packageId) => this.files.exportFolder(auth.user.id, packageId),
      selection,
      includeLocked,
      PRESERVATION_MAX_ITEMS,
    );
    if (!created) {
      throw new BadRequestException(
        `One package holds up to ${PRESERVATION_MAX_ITEMS} items; narrow the selection, for example by year or album`,
      );
    }
    if (created.items === 0) {
      await this.repository.updatePackage(created.package.id, { status: 'removed', removedAt: new Date() });
      throw new BadRequestException('Nothing of yours matches this selection');
    }

    await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.PreservationExport,
      destination: PRESERVATION_DESTINATION,
      destinationDetail: null,
      label: dto.name,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: {
        kind: 'preservation-export',
        packageId: created.package.id,
        requestKey: dto.requestKey ?? null,
        elevated: this.isUnlocked(auth),
      },
      settings: { includeMetadata, includeLocked },
      estimate: null,
      totalUnits: String(created.items),
    });

    this.logger.log(`Preservation package ${created.package.id} queued with ${created.items} items`);
    return this.mapPackage(auth, created.package);
  }

  /**
   * Try again the items an export could not copy. The items it already copied are kept; the new job
   * writes the rest and publishes the package again. Asking while a job is still running answers
   * with that job.
   */
  async retryExport(auth: AuthDto, id: string): Promise<MediaOperationDto> {
    const found = await this.findPackage(auth, id);
    if (found.origin !== 'export' || found.removedAt) {
      throw new BadRequestException('Only an export this server wrote can be retried');
    }
    const active = await this.repository.activeOperation(auth.user.id, 'packageId', found.id);
    if (active) {
      return mapOperation(active);
    }
    if (found.includeLocked && !this.isUnlocked(auth)) {
      throw new ForbiddenException('Unlock the Locked view to retry a package that includes Locked items');
    }

    const reset = await this.repository.resetFailedItems(found.id);
    const counts = (await this.repository.countItems([found.id])).get(found.id);
    const remaining = (counts?.states.pending ?? 0) + (counts?.states.failed ?? 0);
    if (reset === 0 && remaining === 0 && found.status === 'ready') {
      throw new BadRequestException('Every item of this package was written; verify it instead');
    }

    const created = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.PreservationExport,
      destination: PRESERVATION_DESTINATION,
      destinationDetail: null,
      label: found.name,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: { kind: 'preservation-export', packageId: found.id, requestKey: null, elevated: this.isUnlocked(auth) },
      settings: { includeMetadata: found.includeMetadata, includeLocked: found.includeLocked },
      estimate: null,
      totalUnits: null,
    });
    return mapOperation(created);
  }

  /** Queue a check of every file in a package against its manifest. */
  async verifyPackage(auth: AuthDto, id: string): Promise<MediaOperationDto> {
    const found = await this.findPackage(auth, id);
    if (found.removedAt) {
      throw new BadRequestException('This package was removed');
    }
    const active = await this.repository.activeOperation(auth.user.id, 'packageId', found.id);
    if (active) {
      if (active.kind === MediaOperationKind.PreservationVerify) {
        return mapOperation(active);
      }
      throw new ConflictException('Wait for the package’s current job to finish before verifying it');
    }
    if (found.origin === 'export' && found.status === 'building') {
      throw new BadRequestException('This package has not been written yet');
    }

    const created = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.PreservationVerify,
      destination: PRESERVATION_DESTINATION,
      destinationDetail: null,
      label: found.name,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: { kind: 'preservation-verify', packageId: found.id },
      settings: {},
      estimate: null,
      totalUnits: null,
    });
    return mapOperation(created);
  }

  /**
   * Stream a written package as one ZIP: the manifest, the index documents, and every original and
   * sidecar the index names. Stored, not compressed: originals are already compressed, and a
   * package that is streamed is only as trustworthy as the checksums inside it, which a verification
   * of the downloaded copy checks.
   */
  async downloadPackage(auth: AuthDto, id: string): Promise<ImmichReadStream> {
    const found = await this.findDownloadable(auth, id);
    const zip = this.storage.createZipStream();
    const root = found.path;
    zip.addFile(`${root}/${PRESERVATION_MANIFEST_ENTRY}`, PRESERVATION_MANIFEST_ENTRY);
    const manifest = asRecord(found.manifest);
    for (const document of Object.keys(asRecord(manifest.files))) {
      zip.addFile(`${root}/${document}`, document);
    }
    let after: string | null = null;
    for (;;) {
      const page: PreservationItem[] = await this.repository.listedItems(found.id, after, 1000);
      if (page.length === 0) {
        break;
      }
      for (const item of page) {
        const entry = asRecord(item.entry);
        const original = asText(asRecord(entry.original).path);
        const metadata = asText(asRecord(entry.metadata).path);
        if (original) {
          zip.addFile(`${root}/${original}`, original);
        }
        if (metadata) {
          zip.addFile(`${root}/${metadata}`, metadata);
        }
      }
      after = page.at(-1)!.sourceAssetId;
    }
    void zip.finalize().catch((error: unknown) => zip.stream.destroy(error as Error));
    return {
      stream: zip.stream,
      type: 'application/zip',
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(preservationFileName(found.name))}`,
    };
  }

  /** The manifest alone, for a person who wants to read what a package holds before downloading it. */
  async downloadManifest(auth: AuthDto, id: string): Promise<ImmichReadStream> {
    const found = await this.findDownloadable(auth, id);
    const stream = await this.storage.createReadStream(
      `${found.path}/${PRESERVATION_MANIFEST_ENTRY}`,
      'application/json',
    );
    return { ...stream, disposition: 'attachment; filename="manifest.json"' };
  }

  /**
   * Remove a package's files. Library originals are never touched. An exported or uploaded
   * package's own copy is deleted; a package an administrator named on the server is only
   * forgotten, never deleted, because this server did not make it.
   */
  async removePackage(auth: AuthDto, id: string): Promise<void> {
    const found = await this.findPackage(auth, id);
    const active = await this.repository.activeOperation(auth.user.id, 'packageId', found.id);
    if (active) {
      throw new ConflictException('Cancel the package’s current job before removing it');
    }
    const restoring = await this.repository.listRestores(auth.user.id, 200);
    for (const restore of restoring) {
      if (restore.packageId !== found.id) {
        continue;
      }
      if (await this.repository.activeOperation(auth.user.id, 'restoreId', restore.id)) {
        throw new ConflictException('A restoration from this package is still running');
      }
    }

    if (found.origin === 'export') {
      await this.files.removeDirectory(found.path);
    } else if (found.origin === 'upload') {
      await this.files.removeFile(found.path);
    }
    await this.repository.updatePackage(found.id, { status: 'removed', removedAt: new Date() });
    this.logger.log(`Preservation package ${found.id} removed (${found.origin})`);
  }

  /* ------------------------------------------------------------------ */
  /* Reading packages                                                     */
  /* ------------------------------------------------------------------ */

  async listPackages(auth: AuthDto): Promise<PreservationPackageDto[]> {
    this.requireAccount(auth);
    const packages = await this.repository.listPackages(auth.user.id);
    const ids = packages.map((item) => item.id);
    const [counts, operations] = await Promise.all([
      this.repository.countItems(ids, { excludeLocked: !this.isUnlocked(auth) }),
      this.repository.latestOperations(auth.user.id, 'packageId', ids),
    ]);
    return Promise.all(
      packages.map((item) =>
        this.mapPackage(auth, item, { counts: counts.get(item.id), operation: operations.get(item.id) }),
      ),
    );
  }

  async getPackage(auth: AuthDto, id: string): Promise<PreservationPackageDto> {
    return this.mapPackage(auth, await this.findPackage(auth, id));
  }

  /**
   * The item report. An ordinary session never sees a Locked item, not even as a row or in the
   * total; the rows it is given are still checked, so one locked between the two reads stays unnamed.
   */
  async getPackageItems(
    auth: AuthDto,
    id: string,
    dto: PreservationItemsQueryDto,
  ): Promise<PreservationItemsResponseDto> {
    const found = await this.findPackage(auth, id);
    const unlocked = this.isUnlocked(auth);
    const { items, total } = await this.repository.listItems(found.id, {
      state: dto.state,
      verifyState: dto.verifyState,
      take: dto.take ?? 50,
      skip: dto.skip ?? 0,
      excludeLocked: !unlocked,
    });
    const hidden = unlocked ? new Set<string>() : await this.repository.lockedItemIds(items);
    return {
      items: items.filter((item) => !hidden.has(item.id)).map((item) => this.mapItem(item)),
      total,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Packages from elsewhere                                              */
  /* ------------------------------------------------------------------ */

  /**
   * Register a package the owner uploaded. The file is measured and digested and its manifest is
   * read now, so a file that is not a package is refused at once; the originals are verified by the
   * jobs that read them, which can take their time over gigabytes where a request cannot.
   */
  async registerUpload(auth: AuthDto, file: Express.Multer.File | undefined): Promise<PreservationPackageDto> {
    this.requireAccount(auth);
    if (!file?.path) {
      throw new BadRequestException('Choose a preservation package to upload');
    }

    try {
      if (file.size > PRESERVATION_UPLOAD_MAX_BYTES) {
        throw new PreservationPackageError('package_too_large', 'The file is larger than an uploaded package may be');
      }
      const summary = await this.readManifestSummary('zip', file.path);
      const digest = await this.files.sha256File(file.path);
      const created = await this.repository.createPackage({
        ownerId: auth.user.id,
        origin: 'upload',
        name: summary.name ?? basename(file.originalname || 'package.zip').slice(0, 120),
        status: 'building',
        format: 'zip',
        path: file.path,
        originalFileName: basename(file.originalname || 'package.zip').slice(0, 255),
        sizeBytes: file.size,
        digest,
        includeLocked: summary.manifest.scope.includeLocked,
        includeMetadata: summary.manifest.scope.includeMetadata,
        scope: { description: summary.manifest.scope.description },
        manifest: summary.stored,
        expiresAt: hoursFrom(new Date(), PRESERVATION_UPLOAD_TTL_HOURS),
      });
      this.logger.log(`Preservation package upload ${created.id} registered`);
      return this.mapPackage(auth, created);
    } catch (error) {
      await this.files.removeFile(file.path);
      if (error instanceof PreservationPackageError) {
        throw new BadRequestException({ message: error.message, code: error.code });
      }
      throw error;
    }
  }

  /**
   * Register a package an administrator named on this server: a directory or ZIP outside the media
   * storage, too large to upload. It is read in place and never modified or deleted. Only an
   * administrator may name a path, and the package is still restored only into their own library.
   */
  async registerServerPackage(auth: AuthDto, dto: PreservationServerPackageCreateDto): Promise<PreservationPackageDto> {
    this.requireAccount(auth);
    if (!auth.user.isAdmin) {
      throw new ForbiddenException('Only an administrator can name a package on the server');
    }
    try {
      const resolved = await this.files.resolveServerPackage(dto.path);
      const summary = await this.readManifestSummary(resolved.format, resolved.path);
      const created = await this.repository.createPackage({
        ownerId: auth.user.id,
        origin: 'server',
        name: dto.name ?? summary.name ?? basename(resolved.path).slice(0, 120),
        status: 'building',
        format: resolved.format,
        path: resolved.path,
        originalFileName: null,
        sizeBytes: resolved.size,
        digest: null,
        includeLocked: summary.manifest.scope.includeLocked,
        includeMetadata: summary.manifest.scope.includeMetadata,
        scope: { description: summary.manifest.scope.description },
        manifest: summary.stored,
      });
      this.logger.log(`Preservation package ${created.id} registered from a server path`);
      return this.mapPackage(auth, created);
    } catch (error) {
      if (error instanceof PreservationPackageError) {
        throw new BadRequestException({ message: error.message, code: error.code });
      }
      throw error;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Restorations                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Start restoring a package into this account: a review job verifies every file and compares it
   * with the library, and nothing is written until the owner has read the review and asked for the
   * restore itself.
   */
  async createRestore(auth: AuthDto, dto: PreservationRestoreCreateDto): Promise<PreservationRestoreDto> {
    this.requireAccount(auth);

    if (dto.requestKey) {
      const existing = await this.operations.getByRequestKey(
        auth.user.id,
        MediaOperationKind.PreservationReview,
        dto.requestKey,
      );
      if (existing) {
        const restoreId = asText(asRecord(existing.snapshot).restoreId);
        const found = restoreId ? await this.repository.getRestore(restoreId, auth.user.id) : undefined;
        if (!found) {
          throw new ConflictException('This request key was already used');
        }
        return this.mapRestore(auth, found);
      }
    }

    const found = await this.findPackage(auth, dto.packageId);
    if (
      found.removedAt ||
      found.status === 'unreadable' ||
      (found.origin === 'export' && found.status === 'building')
    ) {
      throw new BadRequestException('This package cannot be restored; verify it first');
    }
    if (found.expiresAt && new Date(found.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException('This upload has expired; upload the package again');
    }

    const restore = await this.repository.createRestore({
      ownerId: auth.user.id,
      packageId: found.id,
      name: dto.name ?? found.name,
      status: 'reviewing',
      options: {
        restoreEditRecipes: dto.restoreEditRecipes ?? true,
        conflictDefault: dto.conflictDefault ?? 'keep',
      },
    });
    await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.PreservationReview,
      destination: PRESERVATION_DESTINATION,
      destinationDetail: null,
      label: restore.name,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: {
        kind: 'preservation-review',
        restoreId: restore.id,
        packageId: found.id,
        requestKey: dto.requestKey ?? null,
      },
      settings: {},
      estimate: null,
      totalUnits: null,
    });
    this.logger.log(`Preservation restore ${restore.id} queued for review from package ${found.id}`);
    return this.mapRestore(auth, restore);
  }

  async listRestores(auth: AuthDto): Promise<PreservationRestoreDto[]> {
    this.requireAccount(auth);
    const restores = await this.repository.listRestores(auth.user.id);
    const operations = await this.repository.latestOperations(
      auth.user.id,
      'restoreId',
      restores.map((item) => item.id),
    );
    return Promise.all(restores.map((item) => this.mapRestore(auth, item, operations.get(item.id))));
  }

  async getRestore(auth: AuthDto, id: string): Promise<PreservationRestoreDto> {
    return this.mapRestore(auth, await this.findRestore(auth, id));
  }

  async getRestoreItems(
    auth: AuthDto,
    id: string,
    dto: PreservationRestoreItemsQueryDto,
  ): Promise<PreservationRestoreItemsResponseDto> {
    const found = await this.findRestore(auth, id);
    const unlocked = this.isUnlocked(auth);
    // An ordinary session is not told a Locked item exists: not in the rows, not in the total.
    const { items, total } = await this.repository.listRestoreItems(found.id, {
      filter: dto.filter,
      take: dto.take ?? 50,
      skip: dto.skip ?? 0,
      excludeLocked: !unlocked,
    });
    return {
      items: items.filter((item) => unlocked || !item.locked).map((item) => this.mapRestoreItem(item)),
      total,
    };
  }

  /**
   * Record the owner's choices. They apply to items not yet restored; an item already restored
   * keeps what was done with it, and anything changed on it since. A Locked item's choices can only
   * be made from an unlocked session, as it could only be seen from one.
   */
  async updateDecisions(
    auth: AuthDto,
    id: string,
    dto: PreservationDecisionsUpdateDto,
  ): Promise<PreservationRestoreDto> {
    const found = await this.findRestore(auth, id);
    if (found.status === 'reviewing' || found.status === 'unreadable') {
      throw new BadRequestException('Wait for the review to finish');
    }
    const active = await this.repository.activeOperation(auth.user.id, 'restoreId', found.id);
    if (active && active.status !== MediaOperationStatus.Paused) {
      throw new ConflictException('The restoration is running; pause it to change your choices');
    }

    const options = asRecord(found.options);
    if (dto.conflictDefault !== undefined || dto.restoreEditRecipes !== undefined) {
      await this.repository.updateRestore(found.id, {
        options: {
          ...options,
          ...(dto.conflictDefault !== undefined && { conflictDefault: dto.conflictDefault }),
          ...(dto.restoreEditRecipes !== undefined && { restoreEditRecipes: dto.restoreEditRecipes }),
        },
      });
    }

    if (dto.items?.length) {
      if (!this.isUnlocked(auth)) {
        const lockedIds = await this.repository.lockedRestoreItemIds(
          found.id,
          dto.items.map((item) => item.id),
        );
        if (lockedIds.length > 0) {
          throw new ForbiddenException('Unlock the Locked view to decide about Locked items');
        }
      }
      await this.repository.setDecisions(
        found.id,
        dto.items.map((item) => ({ id: item.id, decisions: sanitizeDecisions(item.decisions) })),
      );
    }

    return this.mapRestore(auth, (await this.repository.getRestore(found.id, auth.user.id))!);
  }

  /**
   * Restore a reviewed package. Only after its review, and only one job at a time. A restoration
   * that stopped part-way is carried on by asking again: items already restored are not touched.
   */
  async applyRestore(auth: AuthDto, id: string): Promise<MediaOperationDto> {
    const found = await this.findRestore(auth, id);
    const active = await this.repository.activeOperation(auth.user.id, 'restoreId', found.id);
    if (active) {
      if (active.kind === MediaOperationKind.PreservationRestore) {
        return mapOperation(active);
      }
      throw new ConflictException('Wait for the review to finish');
    }
    if (found.status !== 'ready' && found.status !== 'restoring' && found.status !== 'completed') {
      throw new BadRequestException('Review the package before restoring it');
    }
    const packageId = found.packageId;
    const source = packageId ? await this.repository.getPackage(packageId, auth.user.id) : undefined;
    if (!source || source.removedAt) {
      throw new BadRequestException('The package this restoration reads from has been removed');
    }

    await this.repository.resetFailedRestoreItems(found.id);
    const created = await this.operations.create({
      ownerId: auth.user.id,
      kind: MediaOperationKind.PreservationRestore,
      destination: PRESERVATION_DESTINATION,
      destinationDetail: null,
      label: found.name,
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: { kind: 'preservation-restore', restoreId: found.id, packageId: source.id, requestKey: null },
      settings: {
        restoreEditRecipes: asRecord(found.options).restoreEditRecipes !== false,
        conflictDefault: asRecord(found.options).conflictDefault === 'replace' ? 'replace' : 'keep',
      },
      estimate: null,
      totalUnits: null,
    });
    await this.repository.updateRestore(found.id, { status: 'restoring' });
    return mapOperation(created);
  }

  /* ------------------------------------------------------------------ */
  /* Account deletion                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * A deleted account's packages go with it. The rows are removed by cascade; the files this server
   * wrote or received are removed here. A package an administrator named on the server is not ours
   * to delete and is left where it is.
   */
  @OnEvent({ name: 'UserDelete' })
  async onUserDelete({ id }: ArgOf<'UserDelete'>) {
    for (const folder of this.files.ownerFolders(id)) {
      try {
        await this.files.removeDirectory(folder);
      } catch (error) {
        this.logger.warn(`Could not remove preservation files of a deleted account: ${String(error).slice(0, 200)}`);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  private requireAccount(auth: AuthDto) {
    if (auth.sharedLink) {
      throw new ForbiddenException('Preservation is not available on a shared link');
    }
  }

  private isUnlocked(auth: AuthDto) {
    return !!getLockedOwnerId(auth);
  }

  private selectionOf(scope: PreservationExportCreateDto['scope']): PreservationSelection {
    if (scope?.assetIds) {
      return { assetIds: [...new Set(scope.assetIds)] };
    }
    return { filter: scope?.filter ?? {} };
  }

  private async findPackage(auth: AuthDto, id: string): Promise<PreservationPackage> {
    this.requireAccount(auth);
    const found = await this.repository.getPackage(id, auth.user.id);
    if (!found) {
      // Somebody else's package and one that never existed give the same answer on purpose.
      throw new NotFoundException('Preservation package not found');
    }
    return found;
  }

  private async findRestore(auth: AuthDto, id: string): Promise<PreservationRestore> {
    this.requireAccount(auth);
    const found = await this.repository.getRestore(id, auth.user.id);
    if (!found) {
      throw new NotFoundException('Restoration not found');
    }
    return found;
  }

  /** A written package, downloadable by this session. */
  private async findDownloadable(auth: AuthDto, id: string): Promise<PreservationPackage> {
    const found = await this.findPackage(auth, id);
    if (found.origin !== 'export' || found.removedAt || (found.status !== 'ready' && found.status !== 'incomplete')) {
      throw new BadRequestException('This package is not ready to download');
    }
    if (!this.isUnlocked(auth) && (found.includeLocked || (await this.repository.hasLockedItems(found.id)))) {
      // A package made with Locked items, by the owner's own choice, says why. One whose items were
      // locked after it was written gets the ordinary answer: a locked session learns nothing of them.
      if (found.includeLocked) {
        throw new ForbiddenException('This package holds Locked items; unlock the Locked view to download it');
      }
      throw new BadRequestException('This package is not ready to download');
    }
    return found;
  }

  /** Read and check an uploaded or named package's manifest before anything is kept. */
  private async readManifestSummary(format: 'directory' | 'zip', path: string) {
    const source = await this.files.openPackage(format, path);
    try {
      const bytes = await source.readDocument(PRESERVATION_MANIFEST_ENTRY, PRESERVATION_MAX_MANIFEST_BYTES);
      const checked = checkPreservationJson(PreservationManifestSchema, bytes);
      if (!checked.ok) {
        throw new PreservationPackageError('package_manifest_invalid', `The manifest is not valid: ${checked.detail}`);
      }
      if (!(await source.has(PRESERVATION_INDEX_ENTRY))) {
        throw new PreservationPackageError('package_entry_missing', 'The package has no index');
      }
      const manifest = checked.value;
      return {
        manifest,
        name: manifest.name.slice(0, 120),
        stored: {
          packageId: manifest.packageId,
          createdAt: manifest.createdAt,
          producerVersion: manifest.producer.version,
          complete: manifest.complete,
          counts: manifest.counts,
          scope: manifest.scope,
          files: manifest.files,
        },
      };
    } finally {
      await source.close();
    }
  }

  private async mapPackage(
    auth: AuthDto,
    item: PreservationPackage,
    preloaded?: {
      counts?: { states: Record<string, number>; locked: number; bytes: number };
      operation?: MediaOperation;
    },
  ): Promise<PreservationPackageDto> {
    const unlocked = this.isUnlocked(auth);
    const counts = preloaded
      ? preloaded.counts
      : (await this.repository.countItems([item.id], { excludeLocked: !unlocked })).get(item.id);
    const operation = preloaded
      ? preloaded.operation
      : (await this.repository.latestOperations(auth.user.id, 'packageId', [item.id])).get(item.id);
    const states = counts?.states ?? {};
    const manifest = asRecord(item.manifest);
    const manifestCounts = asRecord(manifest.counts);
    const manifestScope = asRecord(manifest.scope);
    const verification = asRecord(item.verification);
    const status = oneOf(packageStatuses, item.status, 'building');
    // Only a job that writes the package keeps it from being downloaded or restored; a check only reads.
    const running =
      !!operation &&
      isActiveMediaOperation(operation.status as MediaOperationStatus) &&
      operation.kind === MediaOperationKind.PreservationExport;
    const hasManifest = typeof manifest.packageId === 'string';
    // The owner chose to include Locked items; beyond that choice an ordinary session learns nothing.
    const lockedContent = item.includeLocked || (unlocked && (counts?.locked ?? 0) > 0);

    return {
      id: item.id,
      name: item.name,
      origin: oneOf(['export', 'upload', 'server'] as const, item.origin, 'export'),
      status,
      format: item.format === 'zip' ? 'zip' : 'directory',
      sizeBytes: item.sizeBytes === null ? (counts?.bytes ? String(counts.bytes) : null) : String(item.sizeBytes),
      includeLocked: item.includeLocked,
      includeMetadata: item.includeMetadata,
      scopeDescription: asText(asRecord(item.scope).description),
      createdAt: asIso(item.createdAt)!,
      updatedAt: asIso(item.updatedAt)!,
      expiresAt: asIso(item.expiresAt),
      counts: {
        total: Object.values(states).reduce((sum, value) => sum + value, 0),
        pending: states.pending ?? 0,
        copied: states.copied ?? 0,
        failed: states.failed ?? 0,
        skipped: states.skipped ?? 0,
        listed: states.listed ?? 0,
        locked: unlocked ? (counts?.locked ?? 0) : 0,
      },
      manifest: hasManifest
        ? {
            packageId: manifest.packageId as string,
            createdAt: asIso(asText(manifest.createdAt)) ?? asIso(item.createdAt)!,
            producerVersion: asText(manifest.producerVersion) ?? '',
            complete: manifest.complete === true,
            exported: asInt(manifestCounts.exported),
            failed: asInt(manifestCounts.failed),
            skipped: asInt(manifestCounts.skipped),
            locked: unlocked ? asInt(manifestCounts.locked) : 0,
            includeMetadata: manifestScope.includeMetadata !== false,
            includeLocked: manifestScope.includeLocked === true,
            scopeDescription: asText(manifestScope.description) ?? '',
          }
        : null,
      verification:
        typeof verification.status === 'string'
          ? {
              status: oneOf(['verified', 'problems', 'unreadable'] as const, verification.status, 'problems'),
              reasonKey: asText(verification.reasonKey),
              checked: asInt(verification.checked),
              ok: asInt(verification.ok),
              missing: asInt(verification.missing),
              changed: asInt(verification.changed),
              unexpected: asInt(verification.unexpected),
              documentsChanged: Array.isArray(verification.documentsChanged)
                ? verification.documentsChanged.filter((value): value is string => typeof value === 'string')
                : [],
              finishedAt: asIso(asText(verification.finishedAt)) ?? asIso(item.updatedAt)!,
            }
          : null,
      operation: operation ? mapOperation(operation) : null,
      downloadable:
        item.origin === 'export' && !item.removedAt && (status === 'ready' || status === 'incomplete') && !running,
      restorable:
        !item.removedAt &&
        status !== 'unreadable' &&
        (item.origin !== 'export' || status === 'ready' || status === 'incomplete') &&
        hasManifest &&
        !running,
      lockedContent,
      support: preservationSupportFor(item.includeMetadata),
    };
  }

  /** One item as the report shows it. Only an unlocked session is ever given a Locked one. */
  private mapItem(item: PreservationItem): PreservationItemDto {
    const entry = asRecord(item.entry);
    const original = asRecord(entry.original);
    return {
      id: item.id,
      sourceAssetId: item.sourceAssetId,
      assetId: item.assetId,
      name: asText(entry.originalFileName),
      state: oneOf(itemStates, item.state, 'pending'),
      verifyState: item.verifyState === null ? null : oneOf(verifyStates, item.verifyState, 'changed'),
      locked: item.locked,
      sizeBytes: typeof original.bytes === 'number' ? String(original.bytes) : null,
      sha256: asText(original.sha256),
      reasonKey: item.reasonKey,
      error: item.error,
    };
  }

  private async mapRestore(
    auth: AuthDto,
    item: PreservationRestore,
    preloaded?: MediaOperation,
  ): Promise<PreservationRestoreDto> {
    const operation =
      preloaded ?? (await this.repository.latestOperations(auth.user.id, 'restoreId', [item.id])).get(item.id);
    const unlocked = this.isUnlocked(auth);
    const counts = await this.repository.countRestoreItems(item.id, { excludeLocked: !unlocked });
    const options = asRecord(item.options);
    const summary = asRecord(item.summary);
    return {
      id: item.id,
      name: item.name,
      packageId: item.packageId,
      status: oneOf(restoreStatuses, item.status, 'reviewing'),
      restoreEditRecipes: options.restoreEditRecipes !== false,
      conflictDefault: options.conflictDefault === 'replace' ? 'replace' : 'keep',
      reasonKey: asText(summary.reasonKey),
      albums: asInt(summary.albums),
      people: asInt(summary.people),
      counts: { ...counts, locked: unlocked ? counts.locked : 0 },
      createdAt: asIso(item.createdAt)!,
      updatedAt: asIso(item.updatedAt)!,
      operation: operation ? mapOperation(operation) : null,
      support: preservationSupportFor(summary.includeMetadata !== false),
    };
  }

  /** One restoration item. Only an unlocked session is ever given a Locked one. */
  private mapRestoreItem(item: PreservationRestoreItem): PreservationRestoreItemDto {
    const entry = asRecord(item.entry);
    const decisions = sanitizeDecisions(item.decisions);
    const conflicts = (Array.isArray(item.conflicts) ? item.conflicts : []) as unknown as PreservationConflict[];
    return {
      id: item.id,
      sourceAssetId: item.sourceAssetId,
      assetId: item.assetId,
      name: asText(entry.originalFileName),
      state: oneOf(restoreItemStates, item.state, 'pending'),
      match: item.match === null ? null : oneOf(matches, item.match, 'new'),
      locked: item.locked,
      applied: !!item.appliedAt,
      conflicts: conflicts
        .filter((conflict) => (PRESERVATION_CONFLICT_FIELDS as readonly string[]).includes(conflict.field))
        .map((conflict) => ({
          field: conflict.field,
          archived: asText(conflict.archived),
          current: asText(conflict.current),
          decision: decisions[conflict.field] ?? null,
        })),
      findings: Array.isArray(item.findings) ? item.findings.filter((value) => typeof value === 'string') : [],
      reasonKey: item.reasonKey,
      error: item.error,
    };
  }
}
