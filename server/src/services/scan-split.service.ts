import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { dirname, join, parse } from 'node:path';
import type { JobOf, ScanCropJobItem } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { OnJob } from 'src/decorators.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  ScanSplitDetectResponseDto,
  ScanSplitDto,
  ScanSplitInfoResponseDto,
  ScanSplitOfferResponseDto,
} from 'src/dtos/scan-split.dto.js';
import {
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  JobName,
  JobStatus,
  Permission,
  QueueName,
  StorageFolder,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository, ScanSplitUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import {
  ScanCropPublication,
  ScanSplitGoneError,
  ScanSplitQuotaError,
  ScanSplitRepository,
} from 'src/repositories/scan-split.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { getDimensions } from 'src/utils/asset.util.js';
import { isLockedKeyUnavailable, makeWorkDirFor, withPlainCopy } from 'src/utils/locked-read.js';
import { queueLockedSealFor } from 'src/utils/locked-seal-queue.js';
import { SCAN_CROP_MIN_EDGE, type ScanPoint, fitScanCropRect, scaleScanQuad } from 'src/utils/scan-split.js';
import { TrashReviewAction } from 'src/utils/trash-review.js';

/** The long edge of the upright copy of a scan the ML worker looks for prints on. */
const DETECT_EDGE = 2048;

type Scan = NonNullable<Awaited<ReturnType<ScanSplitRepository['getScan']>>>;
type Rendered = ScanCropPublication & { sha1: Buffer; sha256: Buffer };

/**
 * FL-923: split a flatbed scan holding several prints into separate photos.
 *
 * `detect` asks the instance-local ML worker where the prints lie and saves nothing. `split` takes the corners
 * the owner confirmed and queues `ScanSplit`, which cuts each print out of the original at full resolution,
 * adds it to the owner's library as a new photo and archives the scan. Only the scan's owner may do either.
 */
@Injectable()
export class ScanSplitService {
  constructor(
    private repository: ScanSplitRepository,
    private access: AccessRepository,
    private assets: AssetRepository,
    private checksums: AssetChecksumRepository,
    private crypto: CryptoRepository,
    private events: EventRepository,
    private jobs: JobRepository,
    private logger: LoggingRepository,
    private machineLearning: MachineLearningRepository,
    private media: MediaRepository,
    private physicalFiles: PhysicalFileRepository,
    private storage: StorageRepository,
    private trash: TrashRepository,
  ) {
    this.logger.setContext(ScanSplitService.name);
  }

  /**
   * What the Information panel and the review sheet need. Locked stays out of an unlocked view: a Locked photo of
   * an unlocked scan is only counted (a new split can replace it), and a Locked scan is not named on an unlocked photo.
   */
  async getInfo(auth: AuthDto, id: string): Promise<ScanSplitInfoResponseDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetEditGet, ids: [id] });
    const [scan, earlier, source] = await Promise.all([
      this.repository.getScan(id),
      this.repository.getCrops(id),
      this.repository.getSource(id),
    ]);
    const live = earlier.filter((crop) => !crop.trashed);
    const scanLocked = scan?.visibility === AssetVisibility.Locked;
    const named =
      source &&
      source.ownerId === auth.user.id &&
      (source.sourceVisibility !== AssetVisibility.Locked || source.cropVisibility === AssetVisibility.Locked);
    const size = scan ? getDimensions(scan) : { width: 0, height: 0 };
    return {
      width: size.width || null,
      height: size.height || null,
      crops: live
        .filter((crop) => scanLocked || crop.visibility !== AssetVisibility.Locked)
        .map(({ assetId, quad, rotation, createdAt, edited }) => ({
          assetId,
          quad: quad.map(([x, y]) => ({ x, y })),
          rotation,
          createdAt: new Date(createdAt as unknown as string | Date).toISOString(),
          edited,
        })),
      cropCount: live.length,
      editedCount: live.filter((crop) => crop.edited).length,
      sourceAssetId: named ? source.id : null,
      sourceFileName: named ? source.originalFileName : null,
    };
  }

  /**
   * The upload offer. The album check comes first, so a photo outside an album that holds scans never reaches the
   * ML worker. It only counts: the owner opens the review sheet and confirms before anything is split.
   */
  async offer(auth: AuthDto, id: string): Promise<ScanSplitOfferResponseDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetEditGet, ids: [id] });
    if (!(await this.repository.isInScanAlbum(id))) {
      return { printCount: 0 };
    }
    const earlier = await this.repository.getCrops(id);
    if (earlier.some((crop) => !crop.trashed)) {
      return { printCount: 0 };
    }
    try {
      const { prints } = await this.detect(auth, id);
      return { printCount: prints.length };
    } catch (error) {
      // An offer is optional: no worker, or a file that cannot be read, is simply no offer.
      if (error instanceof ServiceUnavailableException || error instanceof BadRequestException) {
        return { printCount: 0 };
      }
      throw error;
    }
  }

  async detect(auth: AuthDto, id: string): Promise<ScanSplitDetectResponseDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetEditGet, ids: [id] });
    const scan = await this.requireScan(id);
    // The worker gets an upright JPEG no longer than DETECT_EDGE; its corners are scaled back to the scan.
    const { size, copy } = await this.readScan(
      scan,
      async (plain) => {
        const folder = await makeWorkDirFor(plain, 'scan-split');
        try {
          const output = join(folder, 'scan.jpg');
          const size = await this.media.getOrientedSize(plain);
          await this.media.renderDownloadJpeg(plain, output, DETECT_EDGE);
          return { size, copy: await this.storage.readFile(output) };
        } finally {
          await this.storage.unlinkDir(folder, { recursive: true, force: true });
        }
      },
      auth.user.id,
    );
    let found: Awaited<ReturnType<MachineLearningRepository['scanSplitLocal']>>;
    try {
      found = await this.machineLearning.scanSplitLocal(copy);
    } catch (error) {
      if (error instanceof ScanSplitUnavailableError) {
        throw new ServiceUnavailableException({
          message: 'Finding the prints on a scan needs the machine learning service of this server',
          code: 'scan_split_unavailable',
        });
      }
      throw error;
    }
    return {
      ...size,
      prints: found.prints.map(({ quad, rotation, confidence }) => ({
        quad: scaleScanQuad(quad, found, size).map(([x, y]) => ({ x, y })),
        rotation,
        confidence,
      })),
    };
  }

  async split(auth: AuthDto, id: string, dto: ScanSplitDto): Promise<void> {
    await requireAccess(this.access, { auth, permission: Permission.AssetEditCreate, ids: [id] });
    const scan = await this.requireScan(id);
    let size = getDimensions(scan);
    if (!size.width || !size.height) {
      // its metadata has not been read yet: ask the file
      size = await this.readScan(scan, (plain) => this.media.getOrientedSize(plain), auth.user.id);
    }
    const crops: ScanCropJobItem[] = dto.crops.map(({ quad, rotation }) => ({
      quad: quad.map(({ x, y }): ScanPoint => [x, y]),
      rotation,
    }));
    let pixels = 0;
    for (const { quad } of crops) {
      if (quad.some(([x, y]) => x > size.width || y > size.height)) {
        throw new BadRequestException('A corner is outside the scan');
      }
      const rect = fitScanCropRect(quad);
      if (rect.width < SCAN_CROP_MIN_EDGE || rect.height < SCAN_CROP_MIN_EDGE) {
        throw new BadRequestException('A print is too small to cut out');
      }
      pixels += rect.width * rect.height;
    }
    // The job charges the quota for the real files and adds nothing if they do not fit. Refusing here, on an
    // estimate (each print's share of the scan's own size), tells the owner now instead of in a job log.
    const { quotaSizeInBytes, quotaUsageInBytes } = auth.user;
    const estimate = Math.round((Number(scan.fileSizeInByte ?? 0) * pixels) / (size.width * size.height));
    if (quotaSizeInBytes !== null && quotaSizeInBytes < quotaUsageInBytes + estimate) {
      throw new BadRequestException('Quota has been exceeded!');
    }
    await this.jobs.queue({ name: JobName.ScanSplit, data: { id, crops } });
  }

  @OnJob({ name: JobName.ScanSplit, queue: QueueName.Editor })
  async handleSplit({ id, crops }: JobOf<JobName.ScanSplit>): Promise<JobStatus> {
    const scan = await this.repository.getScan(id);
    if (!scan || scan.deletedAt || scan.isOffline || scan.type !== AssetType.Image) {
      return JobStatus.Skipped;
    }
    const earlier = await this.repository.getCrops(id);
    // Files written and not yet a photo's original: removed if the split does not go through.
    const written = new Set<string>();
    let fresh: Rendered[];
    let locked: boolean;
    const unchanged = new Set<string>();
    try {
      // FL-721: an encrypted Locked scan is read through a plain copy; without the key the job waits.
      const rendered = await withPlainCopy(scan.originalPath, (plain) => this.render(scan, plain, crops, written));
      // A print whose pixels the owner already has is not added twice: an earlier photo of this scan with the
      // same pixels stays as it is, and the same corners sent twice give one photo.
      const existing = await this.assets.getByChecksums(
        scan.ownerId,
        rendered.map(({ sha256 }) => sha256),
        { lockedOwnerId: scan.ownerId },
      );
      const owned = new Map(existing.map((asset) => [Buffer.from(asset.checksum).toString('hex'), asset.id]));
      fresh = [];
      for (const crop of rendered) {
        const key = crop.sha256.toString('hex');
        const same = owned.get(key);
        if (same) {
          unchanged.add(same);
          await this.discard(crop.asset.originalPath as string, written);
          continue;
        }
        owned.set(key, crop.asset.id);
        fresh.push(crop);
      }
      ({ locked } = await this.repository.publish(scan.id, fresh, scan.timeZone));
    } catch (error) {
      for (const path of written) {
        await this.storage.unlinkIfExists(path);
      }
      if (error instanceof ScanSplitQuotaError) {
        this.logger.warn(`Scan ${id} was not split: its photos do not fit in the owner's storage quota`);
        return JobStatus.Failed;
      }
      if (error instanceof ScanSplitGoneError) {
        return JobStatus.Skipped;
      }
      // waiting for the owner's Locked key is not a failure: the job is deferred and runs again
      if (!isLockedKeyUnavailable(error)) {
        this.logger.error(`Scan ${id} was not split: ${error}`);
      }
      throw error;
    }

    for (const crop of fresh) {
      const asset = { id: crop.asset.id, ownerId: scan.ownerId };
      const path = crop.asset.originalPath as string;
      await this.checksums.recordAssetChecksums({
        assetId: asset.id,
        sha1: crop.sha1,
        sha256: crop.sha256,
        sizeInBytes: crop.sizeInBytes,
        path,
        source: 'upload',
      });
      await this.physicalFiles.ensureOriginalPhysicalFile(asset.id);
      await this.jobs.queue({ name: JobName.AssetExtractMetadata, data: { id: asset.id, source: 'upload' } });
      // no `file`: the quota was charged when the photos were added
      await this.events.emit('AssetCreate', { asset });
    }
    if (locked) {
      // FL-721: files written for Locked photos are plain until sealed
      await queueLockedSealFor(
        { asset: this.assets, job: this.jobs, logger: this.logger },
        fresh.map(({ asset }) => asset.id),
      );
    }

    // Splitting again replaces the photos of the earlier split that the owner has not worked on since
    // (`ScanSplitRepository.getCrops` has the rule): they go to the trash and are forgotten as this scan's
    // prints. Edited ones, ones already in the trash and ones that came out the same are left alone.
    const replaced = earlier
      .filter((crop) => !crop.edited && !crop.trashed && !unchanged.has(crop.assetId))
      .map(({ assetId }) => assetId);
    if (replaced.length > 0) {
      const trashed = await this.trash.applyReviewed(
        scan.ownerId,
        TrashReviewAction.Trash,
        replaced,
        { lockedOwnerId: scan.ownerId },
        () => true,
      );
      if (trashed && trashed.length > 0) {
        await this.events.emit('AssetTrashAll', { assetIds: trashed, userId: scan.ownerId });
      }
      await this.repository.removeCrops(replaced);
    }
    return JobStatus.Success;
  }

  /**
   * Cuts each print out of the plain scan at full resolution into the owner's upload folder, the way an
   * uploaded photo is stored (the storage template moves it after its metadata is read).
   *
   * What the photo takes from its scan: the date and time zone (the photo's row starts with the scan's dates,
   * and metadata extraction keeps them for a file that carries no date of its own), and the scanner's make and
   * model and the place, written into the file. ponytail: the description, rating, people and tags of the scan
   * are not copied; they describe the sheet of prints, and the owner adds them per photo.
   */
  private async render(scan: Scan, plain: string, crops: ScanCropJobItem[], written: Set<string>) {
    const size = await this.media.getOrientedSize(plain);
    const name = parse(scan.originalFileName).name;
    const rendered: Rendered[] = [];
    for (const [index, { quad, rotation }] of crops.entries()) {
      const id = this.crypto.randomUUID();
      const path = StorageCore.getNestedPath(StorageFolder.Upload, scan.ownerId, `${id}.jpg`);
      this.storage.mkdirSync(dirname(path));
      written.add(path);
      // corners were checked against the size the metadata recorded; the file has the last word
      const inside = quad.map(([x, y]): ScanPoint => [Math.min(x, size.width), Math.min(y, size.height)]);
      const { width, height } = await this.media.renderScanCrop(plain, path, fitScanCropRect(inside), rotation);
      const tags: { make?: string; model?: string; latitude?: number; longitude?: number } = {};
      if (scan.make) {
        tags.make = scan.make;
      }
      if (scan.model) {
        tags.model = scan.model;
      }
      if (scan.latitude !== null && scan.longitude !== null) {
        tags.latitude = scan.latitude;
        tags.longitude = scan.longitude;
      }
      if (Object.keys(tags).length > 0) {
        // a photo without these tags is still a photo: `writeExif` logs and answers false
        await this.media.writeExif(tags, path);
      }
      const { sha1, sha256, sizeInBytes } = await this.crypto.hashFileDigests(path);
      rendered.push({
        asset: {
          id,
          ownerId: scan.ownerId,
          libraryId: null,
          type: AssetType.Image,
          originalPath: path,
          originalFileName: `${name}-${index + 1}.jpg`,
          checksum: sha256,
          checksumAlgorithm: ChecksumAlgorithm.sha256File,
          fileCreatedAt: scan.fileCreatedAt,
          fileModifiedAt: scan.fileModifiedAt,
          localDateTime: scan.localDateTime,
          visibility: AssetVisibility.Timeline,
          isFavorite: false,
          duration: null,
          livePhotoVideoId: null,
        },
        sha1,
        sha256,
        sizeInBytes,
        width,
        height,
        quad: inside,
        rotation,
      });
    }
    return rendered;
  }

  private async discard(path: string, written: Set<string>) {
    await this.storage.unlinkIfExists(path);
    written.delete(path);
  }

  private async requireScan(id: string): Promise<Scan> {
    const scan = await this.repository.getScan(id);
    if (!scan || scan.deletedAt || scan.isOffline || scan.type !== AssetType.Image) {
      throw new BadRequestException('Only a photo that is in the library can be split');
    }
    return scan;
  }

  /** Reads the scan's original (a plain copy of it when it is encrypted in Locked) for the signed-in owner. */
  private async readScan<T>(scan: Scan, read: (plain: string) => Promise<T>, viewerId: string): Promise<T> {
    try {
      return await withPlainCopy(scan.originalPath, read, { viewerId });
    } catch (error) {
      if (isLockedKeyUnavailable(error)) {
        throw error;
      }
      this.logger.warn(`Scan ${scan.id} could not be read: ${error}`);
      throw new BadRequestException('This file cannot be read as a scan');
    }
  }
}
