import { Writable } from 'node:stream';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncService } from 'src/services/sync.service.js';
import { mapPartnerAsset } from 'src/utils/sync.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

const setup = () => {
  const { sut, mocks } = newTestService(SyncService);
  const tag = {
    reconcile: vi.fn().mockResolvedValue([{ eventId: 'delivery-1' }]),
    prepare: vi.fn().mockResolvedValue({
      eventId: 'delivery-1',
      type: SyncEntityType.AlbumAssetAccessV1,
      data: { albumId: 'album-1', asset: { id: 'asset-1', checksum: 'YWJj', thumbhash: null } },
    }),
    acknowledge: vi.fn().mockResolvedValue(true),
    reset: vi.fn(),
  };
  mocks.sync.tag = tag as never;
  mocks.session.isPendingSyncReset.mockResolvedValue(false);
  mocks.syncCheckpoint.getAll.mockResolvedValue([]);
  mocks.syncCheckpoint.upsertAll.mockResolvedValue([]);
  mocks.syncCheckpoint.getNow.mockResolvedValue({ nowId: 'now-id' });
  const chunks: string[] = [];
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { sut, mocks, tag, response, chunks };
};

describe('additive scoped asset access sync dispatch and acknowledgement boundary', () => {
  it('dispatches AlbumAssetAccessV1 and serializes independent delivery IDs', async () => {
    const { sut, response, chunks, tag } = setup();
    await sut.stream(authStub.user1, response, { types: [SyncRequestType.AlbumAssetAccessV1] });
    expect(tag.reconcile).toHaveBeenCalledWith(authStub.user1, 'albumAsset');
    expect(chunks.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'AlbumAssetAccessV1',
        ack: 'AlbumAssetAccessV1|delivery-1',
        data: { albumId: 'album-1', asset: { id: 'asset-1', checksum: 'YWJj', thumbhash: null } },
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
  it('does not serialize an event removed by the current privacy recheck', async () => {
    const { sut, response, chunks, tag } = setup();
    tag.prepare.mockResolvedValue(undefined as never);
    await sut.stream(authStub.user1, response, { types: [SyncRequestType.AlbumAssetAccessV1] });
    expect(chunks.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
  it('routes new-type ack to exact delivery confirmation instead of generic checkpoints', async () => {
    const { sut, mocks, tag } = setup();
    await sut.setAcks(authStub.user1, { acks: ['AlbumAssetAccessDeleteV1|delivery-2'] });
    expect(tag.acknowledge).toHaveBeenCalledWith(authStub.user1.session!.id, {
      type: SyncEntityType.AlbumAssetAccessDeleteV1,
      updateId: 'delivery-2',
      extraId: undefined,
    });
    expect(mocks.syncCheckpoint.upsertAll).not.toHaveBeenCalled();
  });
  it('maps a partner Locked marker as legacy streams did, and sends no partner asset rows (FL-326)', async () => {
    const { sut, response, chunks, tag } = setup();
    const asset = mapPartnerAsset({
      id: 'asset-1',
      checksum: Buffer.from('abc'),
      thumbhash: Buffer.from('private'),
      originalFileName: 'secret.jpg',
      livePhotoVideoId: 'motion',
      isLocked: true,
      visibility: 'locked',
    } as never);
    expect(asset).toEqual({
      id: 'asset-1',
      checksum: 'YWJj',
      thumbhash: null,
      originalFileName: '',
      livePhotoVideoId: null,
      visibility: 'locked',
    });
    tag.prepare.mockResolvedValue({
      eventId: 'delivery-1',
      type: SyncEntityType.PartnerAssetAccessV1,
      data: { sharedById: 'owner-1', asset },
    } as never);
    await sut.stream(authStub.user1, response, { types: [SyncRequestType.PartnerAssetAccessV1] });
    // FL-326 (spec §4.8): the partner asset stream stays for older clients and sends nothing
    expect(tag.reconcile).not.toHaveBeenCalled();
    expect(chunks.map((chunk) => JSON.parse(chunk).type)).toEqual([SyncEntityType.SyncCompleteV1]);
  });
  it('keeps existing-type acknowledgement behavior unchanged', async () => {
    const { sut, mocks, tag } = setup();
    await sut.setAcks(authStub.user1, { acks: ['AssetV2|old-event'] });
    expect(tag.acknowledge).not.toHaveBeenCalled();
    expect(mocks.syncCheckpoint.upsertAll).toHaveBeenCalledWith([
      { sessionId: authStub.user1.session!.id, type: SyncEntityType.AssetV2, ack: 'AssetV2|old-event' },
    ]);
  });
});
