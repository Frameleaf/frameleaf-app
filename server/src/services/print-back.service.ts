import { BadRequestException, Injectable } from '@nestjs/common';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { PrintBackResponseDto, PrintBackUpdateDto } from 'src/dtos/print-back.dto.js';
import { AssetStatus, AssetType, AssetVisibility, JobName, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { DocumentRepository } from 'src/repositories/document.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { PrintBackCandidate, PrintBackRepository } from 'src/repositories/print-back.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { printBackLines, printBackSearchText } from 'src/utils/documents.js';

const usable = (asset: PrintBackCandidate) =>
  asset.type === AssetType.Image && asset.status === AssetStatus.Active && !asset.deletedAt && !asset.isOffline;

/**
 * FL-967: the scan of the back of a print, kept with its front.
 *
 * The back is stored `hidden`, the way a Live Photo's motion part is, and remembers the visibility it came from.
 * Only the owner reaches the back itself. Anyone who may read the front's text (`AssetRead`, and never a shared
 * link) reads the back's text with the owner's corrections, which is the rule the front's own text follows.
 */
@Injectable()
export class PrintBackService {
  constructor(
    private logger: LoggingRepository,
    private access: AccessRepository,
    private repository: PrintBackRepository,
    private ocr: OcrRepository,
    private documents: DocumentRepository,
    private jobs: JobRepository,
    private events: EventRepository,
  ) {
    this.logger.setContext(PrintBackService.name);
  }

  async get(auth: AuthDto, id: string): Promise<PrintBackResponseDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetRead, ids: [id] });
    const pair = await this.repository.getByFront(id);
    if (!pair) {
      return { frontAssetId: id, backAssetId: null, text: null, canEdit: false };
    }
    const isOwner = pair.ownerId === auth.user.id;
    const [lines, edits] = await Promise.all([
      this.ocr.getByAssetId(pair.backAssetId),
      this.documents.getEdits(pair.backAssetId),
    ]);
    const text = printBackLines(lines, edits).join('\n');
    return {
      frontAssetId: id,
      backAssetId: isOwner ? pair.backAssetId : null,
      text: text || null,
      canEdit: isOwner,
    };
  }

  async update(auth: AuthDto, id: string, dto: PrintBackUpdateDto): Promise<PrintBackResponseDto> {
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [id] });
    if (dto.backAssetId === null) {
      await this.unpair(auth, id);
      return this.get(auth, id);
    }
    await requireAccess(this.access, { auth, permission: Permission.AssetUpdate, ids: [dto.backAssetId] });
    const existing = await this.repository.getByFront(id);
    if (existing?.backAssetId !== dto.backAssetId) {
      await this.pair(auth, id, dto.backAssetId);
    }
    return this.get(auth, id);
  }

  private async pair(auth: AuthDto, frontId: string, backId: string) {
    if (frontId === backId) {
      throw new BadRequestException('A photo cannot be its own back');
    }
    const { wasRead } = await this.repository.pair(frontId, backId, (front, back) =>
      this.assertCanPair(auth, front, back),
    );

    const [lines, edits] = await Promise.all([this.ocr.getByAssetId(backId), this.documents.getEdits(backId)]);
    await this.ocr.setPrintBackSearchText(backId, printBackSearchText(lines, edits));
    if (!wasRead) {
      await this.jobs.queue({ name: JobName.Ocr, data: { id: backId } });
    }
    await this.events.emit('AssetHide', { assetId: backId, userId: auth.user.id });
  }

  private async unpair(auth: AuthDto, frontId: string) {
    const removed = await this.repository.unpair(frontId);
    if (!removed) {
      return;
    }
    // back in ordinary search, from its visible lines
    await this.ocr.updateOcrVisibilities(removed.backAssetId, [], []);
    if (removed.backPreviousVisibility !== AssetVisibility.Hidden) {
      await this.events.emit('AssetShow', { assetId: removed.backAssetId, userId: auth.user.id });
    }
  }

  private assertCanPair(auth: AuthDto, front?: PrintBackCandidate, back?: PrintBackCandidate) {
    if (!front || !back || front.ownerId !== auth.user.id || back.ownerId !== auth.user.id) {
      throw new BadRequestException('Both photos must be yours');
    }
    if (!usable(front) || !usable(back)) {
      throw new BadRequestException('Only photos in your library can be paired');
    }
    if (front.isPaired || back.isPaired) {
      throw new BadRequestException('One of these photos is already part of a print');
    }
    // Hidden is a Live Photo's motion part; the other three are files or groups a back cannot quietly leave
    if (back.visibility === AssetVisibility.Hidden || front.visibility === AssetVisibility.Hidden) {
      throw new BadRequestException('A hidden item cannot be paired');
    }
    if (back.livePhotoVideoId || back.stackId || back.libraryId || back.isCopy) {
      throw new BadRequestException('A Live Photo, stacked, external or partner item cannot be a back');
    }
    if (front.isLocked !== back.isLocked || front.isRuleHidden !== back.isRuleHidden) {
      throw new BadRequestException('A Locked photo can only be paired with another Locked photo');
    }
  }
}
