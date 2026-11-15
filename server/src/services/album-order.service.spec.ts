import { BadRequestException } from '@nestjs/common';
import { Mocked, vitest } from 'vitest';
import { AlbumKind, AssetOrder } from 'src/enum.js';
import { AlbumOrderRepository, spreadPositions } from 'src/repositories/album-order.repository.js';
import { AlbumOrderService, cleanBody, cleanHeading } from 'src/services/album-order.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(spreadPositions.name, () => {
  it('splits the gap between two neighbours evenly', () => {
    expect(spreadPositions(1, 2, 3)).toEqual([1.25, 1.5, 1.75]);
  });

  it('places before the first item and after the last', () => {
    expect(spreadPositions(null, 5, 1)).toEqual([4.5]);
    expect(spreadPositions(7, null, 1)).toEqual([7.5]);
    expect(spreadPositions(null, null, 2)).toEqual([1 / 3, 2 / 3]);
  });

  it('asks for renumbering when the gap is too small', () => {
    expect(spreadPositions(1, 1 + 1e-9, 1)).toBeNull();
    expect(spreadPositions(1, 1, 1)).toBeNull();
  });

  it('places 500 photos in one gap', () => {
    const positions = spreadPositions(10, 11, 500)!;
    expect(positions).toHaveLength(500);
    expect(positions.every((value, index) => index === 0 || value > positions[index - 1])).toBe(true);
    expect(positions.at(-1)).toBeLessThan(11);
  });
});

describe('text card cleaning', () => {
  it('keeps a heading on one line and drops control characters', () => {
    expect(cleanHeading('  Day one\r\nat the lake\u{7} ')).toBe('Day one at the lake');
  });

  it('keeps new lines in the body and leaves markup as text', () => {
    expect(cleanBody('<b>Hi</b>\r\nsecond line\0')).toBe('<b>Hi</b>\nsecond line');
  });
});

describe(AlbumOrderService.name, () => {
  let sut: AlbumOrderService;
  let mocks: ServiceMocks;
  let order: Mocked<
    Pick<
      AlbumOrderRepository,
      'place' | 'placeUnplaced' | 'getMembers' | 'getTextCards' | 'createTextCard' | 'updateTextCard' | 'deleteTextCard'
    >
  >;
  const albumId = newUuid();
  const auth = authStub.admin;
  const album = {
    id: albumId,
    kind: AlbumKind.Album,
    order: AssetOrder.Desc,
    isCustomOrder: false,
    albumUsers: [{ user: { id: auth.user.id } }],
  };
  const card = {
    id: 'card-1',
    albumId,
    position: 2.5,
    heading: 'Day one',
    body: '',
    createdById: auth.user.id,
    createdAt: new Date('2026-11-15T00:00:00Z'),
    updatedAt: new Date('2026-11-15T00:00:00Z'),
    afterAssetId: 'a2',
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AlbumOrderService));
    order = {
      place: vitest.fn().mockResolvedValue(true),
      placeUnplaced: vitest.fn().mockResolvedValue(undefined),
      getMembers: vitest.fn().mockImplementation((_, ids: string[]) => Promise.resolve(new Set(ids))),
      getTextCards: vitest.fn().mockResolvedValue([card]),
      createTextCard: vitest.fn().mockResolvedValue('card-1'),
      updateTextCard: vitest.fn().mockResolvedValue(true),
      deleteTextCard: vitest.fn().mockResolvedValue(true),
    };
    Object.assign(mocks.album, { order });
    mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set([albumId]));
    mocks.album.getById.mockResolvedValue(album as never);
  });

  describe('setAssetOrder', () => {
    it('places only photos in the album, in the order given, and turns on custom order', async () => {
      order.getMembers.mockResolvedValue(new Set(['a3', 'a1']));
      await sut.setAssetOrder(auth, albumId, { assetIds: ['a3', 'x', 'a1', 'a3'], afterAssetId: 'a2' });
      expect(order.place).toHaveBeenCalledWith(
        albumId,
        AssetOrder.Desc,
        { afterAssetId: 'a2', afterTextCardId: undefined },
        { assetIds: ['a3', 'a1'], cardIds: [] },
      );
      expect(mocks.album.update).toHaveBeenCalledWith(albumId, { id: albumId, isCustomOrder: true }, auth.user.id);
      expect(mocks.event.emit).toHaveBeenCalledWith('AlbumUpdate', expect.objectContaining({ id: albumId }));
    });

    it('refuses someone who cannot edit the album', async () => {
      mocks.access.album.checkOwnerAccess.mockResolvedValue(new Set());
      mocks.access.album.checkSharedAlbumAccess.mockResolvedValue(new Set());
      await expect(sut.setAssetOrder(auth, albumId, { assetIds: ['a1'], afterAssetId: null })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(order.place).not.toHaveBeenCalled();
    });

    it('refuses a shared link, even one that may upload', async () => {
      await expect(
        sut.setAssetOrder(authStub.adminSharedLink, albumId, { assetIds: ['a1'], afterAssetId: null }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('reports an anchor that is not in the album', async () => {
      order.place.mockResolvedValue(false);
      await expect(sut.setAssetOrder(auth, albumId, { assetIds: ['a1'], afterAssetId: 'gone' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('refuses a collection', async () => {
      mocks.album.getById.mockResolvedValue({ ...album, kind: AlbumKind.Collection } as never);
      await expect(sut.setAssetOrder(auth, albumId, { assetIds: ['a1'], afterAssetId: null })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('text cards', () => {
    it('seeds the custom order before adding a card, then places it', async () => {
      const result = await sut.createTextCard(auth, albumId, { heading: ' Day one ', body: '', afterAssetId: 'a2' });
      expect(order.placeUnplaced).toHaveBeenCalledWith(albumId, AssetOrder.Desc);
      expect(order.createTextCard).toHaveBeenCalledWith({
        albumId,
        heading: 'Day one',
        body: '',
        createdById: auth.user.id,
      });
      expect(order.place).toHaveBeenCalledWith(
        albumId,
        AssetOrder.Desc,
        { afterAssetId: 'a2', afterTextCardId: undefined },
        { assetIds: [], cardIds: ['card-1'] },
      );
      expect(result).toMatchObject({ id: 'card-1', afterAssetId: 'a2', createdAt: '2026-11-15T00:00:00.000Z' });
    });

    it('adds a card at the end when no place is given', async () => {
      await sut.createTextCard(auth, albumId, { heading: 'End', body: '' });
      expect(order.place).not.toHaveBeenCalled();
    });

    it('refuses an empty card', async () => {
      await expect(sut.createTextCard(auth, albumId, { heading: '  ', body: '\n' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(order.createTextCard).not.toHaveBeenCalled();
    });

    it('lets a reader of a shared link list cards but never write', async () => {
      mocks.access.album.checkSharedLinkAccess.mockResolvedValue(new Set([albumId]));
      await expect(sut.getTextCards(authStub.adminSharedLink, albumId)).resolves.toHaveLength(1);
      await expect(
        sut.createTextCard(authStub.adminSharedLink, albumId, { heading: 'x', body: '' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.deleteTextCard(authStub.adminSharedLink, albumId, 'card-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('edits the text without moving the card', async () => {
      await sut.updateTextCard(auth, albumId, 'card-1', { body: 'We arrived late' });
      expect(order.updateTextCard).toHaveBeenCalledWith(albumId, 'card-1', {
        heading: 'Day one',
        body: 'We arrived late',
      });
      expect(order.place).not.toHaveBeenCalled();
    });

    it('refuses an edit that would empty the card', async () => {
      await expect(sut.updateTextCard(auth, albumId, 'card-1', { heading: '' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(order.updateTextCard).not.toHaveBeenCalled();
    });

    it('moves a card to the start of the album', async () => {
      await sut.updateTextCard(auth, albumId, 'card-1', { afterAssetId: null });
      expect(order.place).toHaveBeenCalledWith(
        albumId,
        AssetOrder.Desc,
        { afterAssetId: null, afterTextCardId: undefined },
        { assetIds: [], cardIds: ['card-1'] },
      );
    });

    it('deletes only the card', async () => {
      await sut.deleteTextCard(auth, albumId, 'card-1');
      expect(order.deleteTextCard).toHaveBeenCalledWith(albumId, 'card-1');
      expect(mocks.album.removeAssetIds).not.toHaveBeenCalled();
    });

    it('reports a card that is not in the album', async () => {
      order.deleteTextCard.mockResolvedValue(false);
      await expect(sut.deleteTextCard(auth, albumId, 'other')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
