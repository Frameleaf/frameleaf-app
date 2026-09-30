import { Writable } from 'node:stream';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncService } from 'src/services/sync.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

const setup = () => {
  const { sut, mocks } = newTestService(SyncService);
  const tag = {
    reconcile: vi.fn().mockResolvedValue([{ eventId: 'delivery' }]),
    prepare: vi.fn().mockResolvedValue({ eventId: 'delivery', type: 'AssetTrashStateV1', data: { assetId: 'asset' } }),
    acknowledge: vi.fn().mockResolvedValue(true),
  };
  mocks.sync.tag = tag as never;
  mocks.session.isPendingSyncReset.mockResolvedValue(false);
  mocks.syncCheckpoint.getAll.mockResolvedValue([]);
  mocks.syncCheckpoint.getNow.mockResolvedValue({ nowId: 'now' });
  const chunks: string[] = [];
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { sut, mocks, tag, response, chunks };
};

it('dispatches independent trash-state events through the current privacy recheck', async () => {
  const { sut, tag, response, chunks } = setup();
  await sut.stream(authStub.user1, response, { types: ['AssetTrashStatesV1' as SyncRequestType] });
  expect(tag.reconcile).toHaveBeenCalledWith(authStub.user1, 'trash');
  expect(chunks.map((line) => JSON.parse(line))[0]).toMatchObject({
    type: 'AssetTrashStateV1',
    ack: 'AssetTrashStateV1|delivery',
  });
});
it('does not serialize an event withdrawn before prepare', async () => {
  const { sut, tag, response, chunks } = setup();
  tag.prepare.mockResolvedValue(undefined as never);
  await sut.stream(authStub.user1, response, { types: ['AssetTrashStatesV1' as SyncRequestType] });
  expect(chunks.map((line) => JSON.parse(line))).toEqual([
    expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
  ]);
});
it('routes trash-state deletes to exact delivered-generation acknowledgement', async () => {
  const { sut, tag, mocks } = setup();
  await sut.setAcks(authStub.user1, { acks: ['AssetTrashStateDeleteV1|delivery'] });
  expect(tag.acknowledge).toHaveBeenCalledWith(authStub.user1.session!.id, {
    type: 'AssetTrashStateDeleteV1',
    updateId: 'delivery',
    extraId: undefined,
  });
  expect(mocks.syncCheckpoint.upsertAll).not.toHaveBeenCalled();
});
