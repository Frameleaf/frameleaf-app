import { BadRequestException } from '@nestjs/common';
import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetStatus, AssetType, AssetVisibility, DocumentEditAction, JobName } from 'src/enum.js';
import { PrintBackCandidate, PrintBackRepository } from 'src/repositories/print-back.repository.js';
import { PrintBackService } from 'src/services/print-back.service.js';
import { lineKey } from 'src/utils/documents.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

const owner = authStub.user1;
const viewer = { ...authStub.user1, user: { ...authStub.user1.user, id: '99999999-9999-4999-8999-999999999999' } };
const frontId = '11111111-1111-4111-8111-111111111111';
const backId = '22222222-2222-4222-8222-222222222222';
const box = { x1: 0.1, y1: 0.1, x2: 0.5, y2: 0.1, x3: 0.5, y3: 0.2, x4: 0.1, y4: 0.2 };
const line = (id: string, text: string) => ({
  id,
  assetId: backId,
  text,
  boxScore: 0.9,
  textScore: 0.9,
  isVisible: true,
  ...box,
});

const candidate = (id: string, overrides: Partial<PrintBackCandidate> = {}): PrintBackCandidate => ({
  id,
  ownerId: owner.user.id,
  type: AssetType.Image,
  status: AssetStatus.Active,
  visibility: AssetVisibility.Timeline,
  deletedAt: null,
  isOffline: false,
  libraryId: null,
  stackId: null,
  livePhotoVideoId: null,
  isLocked: false,
  isRuleHidden: false,
  isCopy: false,
  isPaired: false,
  ...overrides,
});

describe(PrintBackService.name, () => {
  let sut: PrintBackService;
  let mocks: ServiceMocks;
  let repository: {
    getByFront: ReturnType<typeof vi.fn>;
    pair: Mock<
      (
        front: string,
        back: string,
        validate: (a?: PrintBackCandidate, b?: PrintBackCandidate) => void,
      ) => Promise<unknown>
    >;
    unpair: ReturnType<typeof vi.fn>;
  };
  let documents: { getEdits: ReturnType<typeof vi.fn> };

  const pairWith = (front: PrintBackCandidate, back: PrintBackCandidate) =>
    repository.pair.mockImplementation((_front, _back, validate) => {
      validate(front, back);
      return Promise.resolve({ ownerId: owner.user.id, wasRead: false, hasPreview: true });
    });

  beforeEach(() => {
    mocks = getMocks();
    repository = {
      getByFront: vi.fn().mockResolvedValue(undefined),
      pair: vi.fn(),
      unpair: vi.fn().mockResolvedValue(undefined),
    };
    documents = { getEdits: vi.fn().mockResolvedValue([]) };
    sut = new PrintBackService(
      mocks.logger as never,
      mocks.access as never,
      repository as unknown as PrintBackRepository,
      mocks.ocr as never,
      documents as never,
      mocks.job as never,
      mocks.event as never,
    );
    mocks.access.asset.checkOwnerAccess.mockImplementation((_user, ids) => Promise.resolve(new Set(ids)));
    mocks.ocr.getByAssetId.mockResolvedValue([]);
  });

  describe('pairing', () => {
    it('hides the back from the timeline, reads it and reports it under the front', async () => {
      pairWith(candidate(frontId), candidate(backId));
      repository.getByFront
        .mockResolvedValueOnce(undefined)
        .mockResolvedValue({ frontAssetId: frontId, backAssetId: backId, ownerId: owner.user.id });
      mocks.ocr.getByAssetId.mockResolvedValue([line('a', 'Bonfire night')]);

      await expect(sut.update(owner, frontId, { backAssetId: backId })).resolves.toEqual({
        frontAssetId: frontId,
        backAssetId: backId,
        text: 'Bonfire night',
        canEdit: true,
      });

      expect(repository.pair).toHaveBeenCalledWith(frontId, backId, expect.any(Function));
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.Ocr, data: { id: backId } });
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetHide', { assetId: backId, userId: owner.user.id });
    });

    it("files the owner's correction as the text search uses", async () => {
      pairWith(candidate(frontId), candidate(backId));
      mocks.ocr.getByAssetId.mockResolvedValue([line('a', 'Bonfrie')]);
      documents.getEdits.mockResolvedValue([
        {
          id: 'edit',
          key: lineKey('a'),
          action: DocumentEditAction.Correct,
          value: 'Bonfire',
          sourceText: 'Bonfrie',
          revision: 1,
          ...box,
        },
      ]);

      await sut.update(owner, frontId, { backAssetId: backId });

      expect(mocks.ocr.setPrintBackSearchText).toHaveBeenCalledWith(backId, 'Bonfire');
    });

    it('does nothing when the same back is sent again', async () => {
      repository.getByFront.mockResolvedValue({ frontAssetId: frontId, backAssetId: backId, ownerId: owner.user.id });

      await sut.update(owner, frontId, { backAssetId: backId });

      expect(repository.pair).not.toHaveBeenCalled();
    });

    it('refuses a photo as its own back', async () => {
      await expect(sut.update(owner, frontId, { backAssetId: frontId })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses someone else's photo as the back", async () => {
      mocks.access.asset.checkOwnerAccess.mockImplementation((_user, ids) =>
        Promise.resolve(new Set([...ids].filter((id) => id === frontId))),
      );

      await expect(sut.update(owner, frontId, { backAssetId: backId })).rejects.toBeInstanceOf(BadRequestException);

      expect(repository.pair).not.toHaveBeenCalled();
    });

    it.each([
      ['a Locked front with an ordinary back', { isLocked: true }, {}],
      ['an ordinary front with a Locked back', {}, { isLocked: true }],
      ['a rule-hidden front with an ordinary back', { isRuleHidden: true }, {}],
      ['an ordinary front with a rule-hidden back', {}, { isRuleHidden: true }],
    ])('refuses %s', async (_name, front, back) => {
      pairWith(candidate(frontId, front), candidate(backId, back));

      await expect(sut.update(owner, frontId, { backAssetId: backId })).rejects.toThrow(
        'A Locked photo can only be paired with another Locked photo',
      );

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('allows two Locked photos', async () => {
      pairWith(candidate(frontId, { isLocked: true }), candidate(backId, { isLocked: true }));

      await expect(sut.update(owner, frontId, { backAssetId: backId })).resolves.toBeDefined();
    });

    it.each([
      ['already part of a print', { isPaired: true }],
      ['a motion part', { visibility: AssetVisibility.Hidden }],
      ['a Live Photo', { livePhotoVideoId: 'motion' }],
      ['in a stack', { stackId: 'stack' }],
      ['in an external library', { libraryId: 'library' }],
      ['a partner copy', { isCopy: true }],
      ['in the trash', { deletedAt: new Date() }],
      ['a video', { type: AssetType.Video }],
    ])('refuses a back that is %s', async (_name, back) => {
      pairWith(candidate(frontId), candidate(backId, back as Partial<PrintBackCandidate>));

      await expect(sut.update(owner, frontId, { backAssetId: backId })).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('unpairing', () => {
    it.each([AssetVisibility.Timeline, AssetVisibility.Archive])('returns a back that was %s', async (visibility) => {
      repository.unpair.mockResolvedValue({ backAssetId: backId, backPreviousVisibility: visibility });

      await expect(sut.update(owner, frontId, { backAssetId: null })).resolves.toEqual({
        frontAssetId: frontId,
        backAssetId: null,
        text: null,
        canEdit: false,
      });

      expect(repository.unpair).toHaveBeenCalledWith(frontId);
      // ordinary search reads the back again
      expect(mocks.ocr.updateOcrVisibilities).toHaveBeenCalledWith(backId, [], []);
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetShow', { assetId: backId, userId: owner.user.id });
    });

    it('is a no-op without a pair', async () => {
      await sut.update(owner, frontId, { backAssetId: null });

      expect(mocks.ocr.updateOcrVisibilities).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });
  });

  describe('sharing', () => {
    beforeEach(() => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set());
      mocks.access.asset.checkItemShareAccess.mockResolvedValue(new Set());
      repository.getByFront.mockResolvedValue({ frontAssetId: frontId, backAssetId: backId, ownerId: owner.user.id });
    });

    it("gives an album member the corrected text and never the back's id", async () => {
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([frontId]));
      mocks.ocr.getByAssetId.mockResolvedValue([line('a', 'Bonfrie'), line('b', 'private note')]);
      documents.getEdits.mockResolvedValue([
        {
          id: 'e1',
          key: lineKey('a'),
          action: DocumentEditAction.Correct,
          value: 'Bonfire',
          sourceText: 'Bonfrie',
          revision: 1,
          ...box,
        },
        {
          id: 'e2',
          key: lineKey('b'),
          action: DocumentEditAction.Dismiss,
          value: null,
          sourceText: 'private note',
          revision: 1,
          ...box,
        },
      ]);

      await expect(sut.get(viewer, frontId)).resolves.toEqual({
        frontAssetId: frontId,
        backAssetId: null,
        text: 'Bonfire',
        canEdit: false,
      });
    });

    it('gives nothing to someone who cannot read the front', async () => {
      await expect(sut.get(viewer, frontId)).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.ocr.getByAssetId).not.toHaveBeenCalled();
    });

    it('does not let a viewer change the pair', async () => {
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([frontId]));

      await expect(sut.update(viewer, frontId, { backAssetId: null })).rejects.toBeInstanceOf(BadRequestException);

      expect(repository.unpair).not.toHaveBeenCalled();
    });
  });
});
