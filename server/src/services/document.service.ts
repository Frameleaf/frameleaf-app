import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { mapAsset } from 'src/dtos/asset-response.dto.js';
import {
  DocumentFieldEditDto,
  DocumentLineEditDto,
  DocumentResponseDto,
  DocumentSearchDto,
  DocumentSearchResponseDto,
} from 'src/dtos/document.dto.js';
import { AssetVisibility, DocumentEditAction, DocumentField, MlWorkload, Permission } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DocumentEdit, DocumentEditConflictError, DocumentRepository } from 'src/repositories/document.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { requireAccess } from 'src/utils/access.js';
import { getDimensions } from 'src/utils/asset.util.js';
import { getConfig } from 'src/utils/config.js';
import { asDateTimeString } from 'src/utils/date.js';
import {
  AssembledDocument,
  DocumentOcrLine,
  DocumentRegion,
  LINE_KEY_PREFIX,
  assembleDocument,
  cropBoxOf,
  fieldKey,
  isRegionInsideCrop,
  lineKey,
  regionOf,
} from 'src/utils/documents.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLockedOwnerId } from 'src/utils/locked.js';
import { isOcrEnabled } from 'src/utils/misc.js';
import { transformOcrBoundingBox } from 'src/utils/transform.js';

type DocumentAsset = NonNullable<Awaited<ReturnType<DocumentRepository['getAsset']>>>;

type DocumentContext = {
  asset: DocumentAsset;
  isOwner: boolean;
  fieldsEnabled: boolean;
  /** Visible recognized lines, original-image coordinates. */
  lines: DocumentOcrLine[];
  edits: DocumentEdit[];
  document: AssembledDocument;
  display: (region: DocumentRegion) => DocumentRegion;
};

const CONFLICT_MESSAGE = 'The text or the decision changed since it was read; reload and try again';

/**
 * Documents (FL-63): photos with recognized text, and the owner's corrections to that text.
 *
 * Reading follows the photo's own access (`AssetRead`): whoever may see a photo may read its text
 * with the owner's corrections applied, as the viewer already could read its raw text. Only the owner
 * lists documents, sees dismissed lines, kept corrections and field suggestions, and changes anything
 * (`AssetUpdate`). Locked photos follow the access rules: their owner, in an elevated session, and
 * nobody else. Background work never goes through here.
 *
 * Recognized text is never written. Reading a photo again goes through the existing text recognition
 * job and its routed processing destination (FL-110), requested with the asset job `refresh-ocr`.
 */
@Injectable()
export class DocumentService {
  constructor(
    private logger: LoggingRepository,
    private accessRepository: AccessRepository,
    private documentRepository: DocumentRepository,
    private ocrRepository: OcrRepository,
    private mlDestinationRepository: MlDestinationRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
  ) {
    this.logger.setContext(DocumentService.name);
  }

  async search(auth: AuthDto, dto: DocumentSearchDto): Promise<DocumentSearchResponseDto> {
    const { items, hasNextPage, total } = await this.documentRepository.search({
      ...getHiddenContentQueryOptions(auth),
      ownerId: auth.user.id,
      lockedOwnerId: getLockedOwnerId(auth),
      query: dto.query,
      page: dto.page,
      size: dto.size,
    });

    return {
      total,
      items: items.map((asset) => mapAsset(asset, { auth })),
      nextPage: hasNextPage ? String(dto.page + 1) : null,
    };
  }

  async get(auth: AuthDto, id: string): Promise<DocumentResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetRead, ids: [id] });
    return this.respond(await this.loadContext(auth, id));
  }

  async editLine(auth: AuthDto, id: string, dto: DocumentLineEditDto): Promise<DocumentResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids: [id] });

    if (dto.action === DocumentEditAction.Confirm) {
      throw new BadRequestException('A line of text can be corrected or dismissed');
    }
    if (dto.action === DocumentEditAction.Correct && !dto.value) {
      throw new BadRequestException('A correction needs text');
    }

    const context = await this.loadContext(auth, id);
    const line = context.lines.find((item) => item.id === dto.ocrId);
    if (!line || line.text !== dto.recognizedText) {
      throw new ConflictException(CONFLICT_MESSAGE);
    }

    const editId = context.document.lines.find((item) => item.ocrId === line.id)?.editId ?? null;
    const existing = editId ? context.edits.find((edit) => edit.id === editId) : undefined;
    this.assertRevision(existing, dto.revision);

    await this.write(async () => {
      if (dto.action === DocumentEditAction.Correct && dto.value === line.text) {
        // correcting a line back to what was read is removing the correction
        if (existing) {
          await this.documentRepository.delete(existing.id, id, existing.revision);
        }
        return;
      }

      const values = {
        key: lineKey(line.id),
        action: dto.action,
        value: dto.action === DocumentEditAction.Correct ? dto.value! : null,
        sourceText: line.text,
        ...regionOf(line),
        editedById: auth.user.id,
      };

      await (existing
        ? this.documentRepository.update(existing.id, existing.revision, values)
        : this.documentRepository.create({ ...values, assetId: id }));
    });

    return this.respond(await this.loadContext(auth, id));
  }

  async removeLineEdit(auth: AuthDto, id: string, editId: string, revision: number): Promise<DocumentResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids: [id] });

    const edits = await this.documentRepository.getEdits(id);
    const edit = edits.find((item) => item.id === editId && item.key.startsWith(LINE_KEY_PREFIX));
    if (!edit) {
      throw new NotFoundException('Correction not found');
    }

    await this.write(() => this.documentRepository.delete(edit.id, id, revision));
    return this.respond(await this.loadContext(auth, id));
  }

  async editField(
    auth: AuthDto,
    id: string,
    field: DocumentField,
    dto: DocumentFieldEditDto,
  ): Promise<DocumentResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids: [id] });

    const context = await this.loadContext(auth, id);
    if (!context.fieldsEnabled) {
      throw new BadRequestException('Field suggestions are switched off');
    }

    // The revision a change names is the one the owner could see. A stored decision a crop hides is
    // not shown, so a change made without it replaces it at its own revision instead of being refused.
    const stored = context.edits.find((edit) => edit.key === fieldKey(field));
    const shown = context.document.fields.find((item) => item.field === field && item.editId !== null);
    if ((dto.revision ?? null) !== (shown?.revision ?? null)) {
      throw new ConflictException(CONFLICT_MESSAGE);
    }

    let values: { value: string | null; sourceText: string | null; region: DocumentRegion | null };
    switch (dto.action) {
      case DocumentEditAction.Confirm: {
        // only a value the text suggests right now can be confirmed, exactly as it was offered
        const candidates = context.document.fields.find((item) => item.field === field)?.candidates ?? [];
        const candidate = candidates.find((item) => item.lineId === dto.lineId && item.value === dto.value);
        const line = candidate ? context.lines.find((item) => item.id === candidate.lineId) : undefined;
        if (!candidate || !line) {
          throw new ConflictException(CONFLICT_MESSAGE);
        }
        values = { value: candidate.value, sourceText: line.text, region: regionOf(line) };
        break;
      }

      case DocumentEditAction.Correct: {
        if (!dto.value) {
          throw new BadRequestException('A correction needs a value');
        }
        if (!dto.lineId) {
          values = { value: dto.value, sourceText: null, region: null };
          break;
        }
        const line = context.lines.find((item) => item.id === dto.lineId);
        if (!line || (dto.recognizedText !== undefined && dto.recognizedText !== line.text)) {
          throw new ConflictException(CONFLICT_MESSAGE);
        }
        values = { value: dto.value, sourceText: line.text, region: regionOf(line) };
        break;
      }

      default: {
        values = { value: null, sourceText: null, region: null };
      }
    }

    const row = {
      key: fieldKey(field),
      action: dto.action,
      value: values.value,
      sourceText: values.sourceText,
      x1: values.region?.x1 ?? null,
      y1: values.region?.y1 ?? null,
      x2: values.region?.x2 ?? null,
      y2: values.region?.y2 ?? null,
      x3: values.region?.x3 ?? null,
      y3: values.region?.y3 ?? null,
      x4: values.region?.x4 ?? null,
      y4: values.region?.y4 ?? null,
      editedById: auth.user.id,
    };

    await this.write(() =>
      stored
        ? this.documentRepository.update(stored.id, stored.revision, row)
        : this.documentRepository.create({ ...row, assetId: id }),
    );

    return this.respond(await this.loadContext(auth, id));
  }

  async removeFieldEdit(
    auth: AuthDto,
    id: string,
    field: DocumentField,
    revision: number,
  ): Promise<DocumentResponseDto> {
    await requireAccess(this.accessRepository, { auth, permission: Permission.AssetUpdate, ids: [id] });

    const edits = await this.documentRepository.getEdits(id);
    const edit = edits.find((item) => item.key === fieldKey(field));
    if (!edit) {
      throw new NotFoundException('Decision not found');
    }

    await this.write(() => this.documentRepository.delete(edit.id, id, revision));
    return this.respond(await this.loadContext(auth, id));
  }

  /** A change names the revision it read: the existing decision's, or none when there was none. */
  private assertRevision(existing: DocumentEdit | undefined, revision: number | null | undefined) {
    const expected = existing?.revision ?? null;
    if ((revision ?? null) !== expected) {
      throw new ConflictException(CONFLICT_MESSAGE);
    }
  }

  private async write(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (error) {
      if (error instanceof DocumentEditConflictError) {
        throw new ConflictException(CONFLICT_MESSAGE);
      }
      throw error;
    }
  }

  private async loadContext(auth: AuthDto, id: string): Promise<DocumentContext> {
    const asset = await this.documentRepository.getAsset(id);
    if (!asset) {
      throw new BadRequestException('Asset not found');
    }

    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: true },
    );

    const isOwner = asset.ownerId === auth.user.id;
    const dimensions = getDimensions(asset);
    const cropBox = cropBoxOf(asset.edits);
    const isRegionVisible = (region: DocumentRegion) => isRegionInsideCrop(region, dimensions, cropBox);

    // The hidden video part of a live photo is never read and never a document, like every hidden
    // source. A line the crop removes is left out even if its stored visibility says otherwise.
    const recognized = asset.visibility === AssetVisibility.Hidden ? [] : await this.ocrRepository.getByAssetId(id);
    const lines = recognized.filter((line) => isRegionVisible(line));
    const edits = await this.documentRepository.getEdits(id);

    const fieldsEnabled = config.machineLearning.ocr.documentFields;
    const document = assembleDocument({
      lines,
      edits,
      isRegionVisible,
      isOwner,
      fieldsEnabled,
    });

    const display = (region: DocumentRegion) =>
      regionOf(
        transformOcrBoundingBox(
          { id: '', assetId: id, text: '', boxScore: 0, textScore: 0, ...region },
          asset.edits,
          dimensions,
        ),
      );

    return { asset, isOwner, fieldsEnabled, lines, edits, document, display };
  }

  private async respond({ asset, isOwner, fieldsEnabled, document, display }: DocumentContext) {
    let recognition: DocumentResponseDto['recognition'] = null;
    if (isOwner) {
      const config = await getConfig(
        { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
        { withCache: true },
      );
      const route = await this.mlDestinationRepository.getRoute(MlWorkload.Ocr);
      recognition = { enabled: isOcrEnabled(config.machineLearning), routed: !!route };
    }

    return {
      assetId: asset.id,
      canEdit: isOwner,
      recognizedAt: asset.ocrAt ? asDateTimeString(asset.ocrAt) : null,
      lines: document.lines.map((line) => ({ ...line, region: line.region ? display(line.region) : null })),
      fieldsEnabled: isOwner && fieldsEnabled,
      fields: document.fields.map((field) => ({
        ...field,
        region: field.region ? display(field.region) : null,
        candidates: field.candidates.map((candidate) => ({ ...candidate, region: display(candidate.region) })),
        updatedAt: field.updatedAt ? asDateTimeString(field.updatedAt) : null,
      })),
      recognition,
    } satisfies DocumentResponseDto;
  }
}
