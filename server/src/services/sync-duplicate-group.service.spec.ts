import { Writable } from 'node:stream';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncService } from 'src/services/sync.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

const setup = () => {
  const { sut, mocks } = newTestService(SyncService);
  const tag = {
    reconcile: vi.fn().mockResolvedValue([{ eventId: 'delivery-1' }]),
    prepare: vi.fn().mockResolvedValue({
      eventId: 'delivery-1',
      type: SyncEntityType.DuplicateGroupV1,
      data: { groupId: 'group-1', assetIds: ['asset-1', 'asset-2'] },
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

describe('additive duplicate-group sync dispatch and acknowledgement boundary', () => {
  it('dispatches DuplicateGroupsV1 and serializes independent delivery IDs', async () => {
    const { sut, response, chunks, tag } = setup();
    await sut.stream(authStub.user1, response, { types: [SyncRequestType.DuplicateGroupsV1] });
    expect(tag.reconcile).toHaveBeenCalledWith(authStub.user1, 'duplicate');
    expect(chunks.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'DuplicateGroupV1',
        ack: 'DuplicateGroupV1|delivery-1',
        data: { groupId: 'group-1', assetIds: ['asset-1', 'asset-2'] },
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
  it('does not serialize an event removed by the current privacy recheck', async () => {
    const { sut, response, chunks, tag } = setup();
    tag.prepare.mockResolvedValue(undefined as never);
    await sut.stream(authStub.user1, response, { types: [SyncRequestType.DuplicateGroupsV1] });
    expect(chunks.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
  it('routes new-type ack to exact delivery confirmation instead of generic checkpoints', async () => {
    const { sut, mocks, tag } = setup();
    await sut.setAcks(authStub.user1, { acks: ['DuplicateGroupDeleteV1|delivery-2'] });
    expect(tag.acknowledge).toHaveBeenCalledWith(authStub.user1.session!.id, {
      type: SyncEntityType.DuplicateGroupDeleteV1,
      updateId: 'delivery-2',
      extraId: undefined,
    });
    expect(mocks.syncCheckpoint.upsertAll).not.toHaveBeenCalled();
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
