import { BadRequestException, ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthSession } from 'src/database.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import {
  AssetType,
  AssetVisibility,
  DocumentEditAction,
  DocumentField,
  DocumentFieldStatus,
  DocumentLineStatus,
} from 'src/enum.js';
import { DocumentEditConflictError, DocumentRepository } from 'src/repositories/document.repository.js';
import { DocumentService } from 'src/services/document.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { fieldKey, lineKey } from 'src/utils/documents.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const ownerId = authStub.user1.user.id;
const assetId = '33333333-3333-4333-8333-333333333333';
const lineId = '44444444-4444-4444-8444-444444444444';
const totalLineId = '55555555-5555-4555-8555-555555555555';
const editId = '66666666-6666-4666-8666-666666666666';

/** The owner, unlocked with the PIN: the only session that reaches their Locked photos. */
const elevatedAuth = { ...authStub.user1, session: { id: 'token-id', hasElevatedPermission: true } as AuthSession };

const region = (x: number, y: number) => ({
  x1: x,
  y1: y,
  x2: x + 0.3,
  y2: y,
  x3: x + 0.3,
  y3: y + 0.05,
  x4: x,
  y4: y + 0.05,
});

const ocrLine = (id: string, text: string, y: number) => ({
  id,
  assetId,
  text,
  boxScore: 0.9,
  textScore: 0.85,
  isVisible: true,
  updatedAt: new Date('2026-09-20T00:00:00.000Z'),
  updateId: 'update-id',
  ...region(0.1, y),
});

const documentAsset = (overrides: Record<string, unknown> = {}) => ({
  id: assetId,
  ownerId,
  visibility: AssetVisibility.Timeline,
  deletedAt: null,
  type: AssetType.Image,
  edits: [] as Array<{ action: AssetEditAction; parameters: Record<string, number> }>,
  exifImageWidth: 1000,
  exifImageHeight: 1000,
  orientation: null,
  ocrAt: new Date('2026-09-20T00:00:00.000Z'),
  ...overrides,
});

const storedEdit = (overrides: Record<string, unknown> = {}) => ({
  id: editId,
  assetId,
  key: lineKey(lineId),
  action: DocumentEditAction.Correct,
  value: 'Lake Agnes',
  sourceText: 'LAKE AGNES',
  ...region(0.1, 0.1),
  revision: 2,
  editedById: ownerId,
  createdAt: new Date('2026-09-21T00:00:00.000Z'),
  updatedAt: new Date('2026-09-21T00:00:00.000Z'),
  ...overrides,
});

describe(DocumentService.name, () => {
  let sut: DocumentService;
  let mocks: ServiceMocks;
  let documentRepository: {
    search: ReturnType<typeof vi.fn>;
    getAsset: ReturnType<typeof vi.fn>;
    getEdits: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  const withFieldSuggestions = () =>
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { ocr: { documentFields: true } } });

  beforeEach(() => {
    clearConfigCache();
    mocks = getMocks();
    documentRepository = {
      search: vi.fn().mockResolvedValue({ items: [], hasNextPage: false, total: 0 }),
      getAsset: vi.fn().mockResolvedValue(documentAsset()),
      getEdits: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockImplementation((value) => Promise.resolve(storedEdit(value))),
      update: vi.fn().mockImplementation((id, _revision, value) => Promise.resolve(storedEdit({ ...value, id }))),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    sut = new DocumentService(
      mocks.logger as never,
      mocks.access as never,
      documentRepository as unknown as DocumentRepository,
      mocks.ocr as never,
      mocks.mlDestination as never,
      mocks.config as never,
      mocks.systemMetadata as never,
    );

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    mocks.ocr.getByAssetId.mockResolvedValue([ocrLine(lineId, 'LAKE AGNES', 0.1)]);
    mocks.mlDestination.getRoute.mockResolvedValue(undefined);
  });

  describe('search', () => {
    it('lists only the caller’s own documents and their Locked ones only while unlocked', async () => {
      await sut.search(elevatedAuth, { query: 'agnes', page: 1, size: 50 });

      expect(documentRepository.search).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId, lockedOwnerId: ownerId, query: 'agnes', page: 1, size: 50 }),
      );

      await sut.search(authStub.user1, { page: 1, size: 50 });

      expect(documentRepository.search).toHaveBeenLastCalledWith(
        expect.objectContaining({ ownerId, lockedOwnerId: undefined }),
      );
    });

    it('maps the page and says where the next one starts', async () => {
      const asset = AssetFactory.create({ ownerId });
      documentRepository.search.mockResolvedValue({ items: [asset], hasNextPage: true, total: 51 });

      const response = await sut.search(authStub.user1, { page: 1, size: 50 });

      expect(response).toEqual({ total: 51, items: [expect.objectContaining({ id: asset.id })], nextPage: '2' });
    });
  });

  describe('get', () => {
    it('refuses a photo the caller cannot read', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.get(authStub.user1, assetId)).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.ocr.getByAssetId).not.toHaveBeenCalled();
    });

    it('reads the owner’s corrections over the recognized text, which stays as provenance', async () => {
      documentRepository.getEdits.mockResolvedValue([storedEdit()]);

      const response = await sut.get(authStub.user1, assetId);

      expect(response).toMatchObject({
        assetId,
        canEdit: true,
        recognizedAt: '2026-09-20T00:00:00.000Z',
        lines: [
          {
            ocrId: lineId,
            status: DocumentLineStatus.Corrected,
            text: 'Lake Agnes',
            recognizedText: 'LAKE AGNES',
            editId,
            revision: 2,
          },
        ],
        fieldsEnabled: false,
        fields: [],
        recognition: { enabled: true, routed: false },
      });
    });

    it('never reads the text of a hidden source such as the video part of a live photo', async () => {
      documentRepository.getAsset.mockResolvedValue(documentAsset({ visibility: AssetVisibility.Hidden }));

      const response = await sut.get(authStub.user1, assetId);

      expect(response.lines).toEqual([]);
      expect(mocks.ocr.getByAssetId).not.toHaveBeenCalled();
    });

    it('shows another viewer the corrected text only, without dismissed text or the owner’s tools', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([assetId]));
      documentRepository.getAsset.mockResolvedValue(documentAsset({ ownerId: 'someone-else' }));
      mocks.ocr.getByAssetId.mockResolvedValue([
        ocrLine(lineId, 'LAKE AGNES', 0.1),
        ocrLine(totalLineId, 'private note', 0.5),
      ]);
      documentRepository.getEdits.mockResolvedValue([
        storedEdit(),
        storedEdit({ id: 'dismissed', key: lineKey(totalLineId), action: DocumentEditAction.Dismiss, value: null }),
      ]);
      withFieldSuggestions();

      const response = await sut.get(authStub.user1, assetId);

      expect(response.canEdit).toBe(false);
      expect(response.lines.map((line) => [line.ocrId, line.text])).toEqual([
        [lineId, 'Lake Agnes'],
        [totalLineId, ''],
      ]);
      expect(response.lines[0]).toMatchObject({ recognizedText: null, confidence: null });
      expect(response.fields).toEqual([]);
      expect(response.recognition).toBeNull();
      expect(JSON.stringify(response)).not.toContain('private note');
      expect(JSON.stringify(response)).not.toContain('LAKE AGNES');
    });

    it('never reads a line a crop removes, whatever its stored visibility says', async () => {
      documentRepository.getAsset.mockResolvedValue(
        documentAsset({
          edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 400 } }],
        }),
      );
      mocks.ocr.getByAssetId.mockResolvedValue([
        ocrLine(lineId, 'LAKE AGNES', 0.1),
        ocrLine(totalLineId, 'card 4111', 0.8),
      ]);

      const response = await sut.get(authStub.user1, assetId);

      expect(response.lines.map((line) => line.ocrId)).toEqual([lineId]);
      expect(JSON.stringify(response)).not.toContain('card 4111');
    });

    it('hides a correction whose text a crop removed', async () => {
      documentRepository.getAsset.mockResolvedValue(
        documentAsset({
          edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 400 } }],
        }),
      );
      // the recognition hides a line a crop removes, so only the line at the top is read
      mocks.ocr.getByAssetId.mockResolvedValue([ocrLine(lineId, 'LAKE AGNES', 0.1)]);
      documentRepository.getEdits.mockResolvedValue([
        storedEdit({ id: 'cropped', key: lineKey('gone'), value: 'card 4111', ...region(0.1, 0.8) }),
      ]);

      const response = await sut.get(authStub.user1, assetId);

      expect(response.lines.map((line) => line.text)).toEqual(['LAKE AGNES']);
      expect(JSON.stringify(response)).not.toContain('card 4111');
    });
  });

  describe('editLine', () => {
    it('records a correction beside the recognized text, never over it', async () => {
      await sut.editLine(authStub.user1, assetId, {
        ocrId: lineId,
        recognizedText: 'LAKE AGNES',
        action: DocumentEditAction.Correct,
        value: 'Lake Agnes',
      });

      expect(documentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId,
          key: lineKey(lineId),
          action: DocumentEditAction.Correct,
          value: 'Lake Agnes',
          sourceText: 'LAKE AGNES',
          ...region(0.1, 0.1),
          editedById: ownerId,
        }),
      );
      expect(mocks.ocr.upsert).not.toHaveBeenCalled();
      expect(mocks.ocr.updateOcrVisibilities).not.toHaveBeenCalled();
    });

    it('refuses a change against text that was read differently since', async () => {
      await expect(
        sut.editLine(authStub.user1, assetId, {
          ocrId: lineId,
          recognizedText: 'LAKE AGNE5',
          action: DocumentEditAction.Correct,
          value: 'Lake Agnes',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(documentRepository.create).not.toHaveBeenCalled();
    });

    it('refuses a change that names the wrong revision of the existing correction', async () => {
      documentRepository.getEdits.mockResolvedValue([storedEdit()]);

      await expect(
        sut.editLine(authStub.user1, assetId, {
          ocrId: lineId,
          recognizedText: 'LAKE AGNES',
          action: DocumentEditAction.Dismiss,
          revision: 1,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(documentRepository.update).not.toHaveBeenCalled();
    });

    it('changes the existing correction at the revision it read', async () => {
      documentRepository.getEdits.mockResolvedValue([storedEdit()]);

      await sut.editLine(authStub.user1, assetId, {
        ocrId: lineId,
        recognizedText: 'LAKE AGNES',
        action: DocumentEditAction.Dismiss,
        revision: 2,
      });

      expect(documentRepository.update).toHaveBeenCalledWith(
        editId,
        2,
        expect.objectContaining({ action: DocumentEditAction.Dismiss, value: null }),
      );
    });

    it('removes the correction when the text is corrected back to what was read', async () => {
      documentRepository.getEdits.mockResolvedValue([storedEdit()]);

      await sut.editLine(authStub.user1, assetId, {
        ocrId: lineId,
        recognizedText: 'LAKE AGNES',
        action: DocumentEditAction.Correct,
        value: 'LAKE AGNES',
        revision: 2,
      });

      expect(documentRepository.delete).toHaveBeenCalledWith(editId, assetId, 2);
      expect(documentRepository.update).not.toHaveBeenCalled();
    });

    it('reports a write that lost a race as a conflict', async () => {
      documentRepository.create.mockRejectedValue(new DocumentEditConflictError('taken'));

      await expect(
        sut.editLine(authStub.user1, assetId, {
          ocrId: lineId,
          recognizedText: 'LAKE AGNES',
          action: DocumentEditAction.Dismiss,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('refuses a change to someone else’s photo', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(
        sut.editLine(authStub.user1, assetId, {
          ocrId: lineId,
          recognizedText: 'LAKE AGNES',
          action: DocumentEditAction.Dismiss,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(documentRepository.getAsset).not.toHaveBeenCalled();
    });

    it('does not confirm a line', async () => {
      await expect(
        sut.editLine(authStub.user1, assetId, {
          ocrId: lineId,
          recognizedText: 'LAKE AGNES',
          action: DocumentEditAction.Confirm,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('editField', () => {
    beforeEach(() => {
      mocks.ocr.getByAssetId.mockResolvedValue([
        ocrLine(lineId, 'Date 2026-09-23', 0.1),
        ocrLine(totalLineId, 'TOTAL 12.50', 0.6),
      ]);
    });

    it('is refused while field suggestions are switched off', async () => {
      await expect(
        sut.editField(authStub.user1, assetId, DocumentField.Total, { action: DocumentEditAction.Dismiss }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirms a suggested value with the line it was read from', async () => {
      withFieldSuggestions();

      const response = await sut.editField(authStub.user1, assetId, DocumentField.Total, {
        action: DocumentEditAction.Confirm,
        value: '12.50',
        lineId: totalLineId,
      });

      expect(documentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          key: fieldKey(DocumentField.Total),
          action: DocumentEditAction.Confirm,
          value: '12.50',
          sourceText: 'TOTAL 12.50',
          ...region(0.1, 0.6),
        }),
      );
      expect(response.fieldsEnabled).toBe(true);
    });

    it('refuses to confirm a value the text does not suggest', async () => {
      withFieldSuggestions();

      await expect(
        sut.editField(authStub.user1, assetId, DocumentField.Total, {
          action: DocumentEditAction.Confirm,
          value: '99.99',
          lineId: totalLineId,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(documentRepository.create).not.toHaveBeenCalled();
    });

    it('keeps a typed correction without evidence as the owner’s own value', async () => {
      withFieldSuggestions();

      await sut.editField(authStub.user1, assetId, DocumentField.Total, {
        action: DocumentEditAction.Correct,
        value: '12.05',
      });

      expect(documentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ value: '12.05', sourceText: null, x1: null, y4: null }),
      );
    });

    it('replaces a decision a crop hides at its own revision instead of refusing forever', async () => {
      withFieldSuggestions();
      documentRepository.getAsset.mockResolvedValue(
        documentAsset({
          edits: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1000, height: 700 } }],
        }),
      );
      documentRepository.getEdits.mockResolvedValue([
        storedEdit({
          key: fieldKey(DocumentField.Total),
          action: DocumentEditAction.Confirm,
          value: '99.99',
          sourceText: 'TOTAL 99.99',
          revision: 4,
          ...region(0.1, 0.9),
        }),
      ]);

      await sut.editField(authStub.user1, assetId, DocumentField.Total, {
        action: DocumentEditAction.Confirm,
        value: '12.50',
        lineId: totalLineId,
      });

      expect(documentRepository.update).toHaveBeenCalledWith(
        editId,
        4,
        expect.objectContaining({ value: '12.50', sourceText: 'TOTAL 12.50' }),
      );
    });

    it('shows the suggestion again once the decision is cleared at its revision', async () => {
      withFieldSuggestions();
      documentRepository.getEdits.mockResolvedValue([
        storedEdit({ key: fieldKey(DocumentField.Total), action: DocumentEditAction.Dismiss, value: null }),
      ]);

      await sut.removeFieldEdit(authStub.user1, assetId, DocumentField.Total, 2);

      expect(documentRepository.delete).toHaveBeenCalledWith(editId, assetId, 2);
    });

    it('suggests with the evidence region and never as decided', async () => {
      withFieldSuggestions();

      const response = await sut.get(authStub.user1, assetId);

      expect(response.fields.find((field) => field.field === DocumentField.Total)).toMatchObject({
        status: DocumentFieldStatus.Suggested,
        value: '12.50',
        lineId: totalLineId,
        confidence: 0.85,
        region: region(0.1, 0.6),
      });
    });
  });
});
