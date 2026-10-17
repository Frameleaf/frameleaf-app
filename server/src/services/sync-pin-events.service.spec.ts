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
      type: SyncEntityType.PinnedCollectionV1,
      data: { id: 'pin-1', kind: 'builtin', targetId: 'photos', position: 0 },
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

describe('additive pin-event sync dispatch and acknowledgement boundary', () => {
  it('dispatches PinnedCollectionEventsV1 and serializes independent delivery IDs', async () => {
    const { sut, response, chunks, tag } = setup();
    await sut.stream(authStub.user1, response, { types: [SyncRequestType.PinnedCollectionEventsV1] });
    expect(tag.reconcile).toHaveBeenCalledWith(authStub.user1, 'pin', expect.any(Function));
    expect(chunks.map((line) => JSON.parse(line))).toEqual([
      {
        type: 'PinnedCollectionV1',
        ack: 'PinnedCollectionV1|delivery-1',
        data: { id: 'pin-1', kind: 'builtin', targetId: 'photos', position: 0 },
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
  it('binds the current authenticated hydration reader independently at reconciliation and prepare', async () => {
    const { sut, response, tag } = setup();
    const get = vi.fn().mockResolvedValue({ revision: null, pins: [] });
    Object.assign(sut, { pins: { get } });
    tag.reconcile.mockImplementation(async (...args: unknown[]) => {
      await (args[2] as () => Promise<unknown>)();
      return [{ eventId: 'delivery-1' }];
    });
    const item = {
      eventId: 'delivery-1',
      type: SyncEntityType.PinnedCollectionV1,
      data: { id: 'pin-1', kind: 'builtin', targetId: 'photos', position: 0 },
    };
    tag.prepare.mockImplementation(async (...args: unknown[]) => {
      await (args[3] as () => Promise<unknown>)();
      return item;
    });
    await sut.stream(authStub.user1, response, { types: [SyncRequestType.PinnedCollectionEventsV1] });
    expect(get.mock.calls).toEqual([[authStub.user1], [authStub.user1]]);
  });
  it('does not serialize an event removed by the current privacy recheck', async () => {
    const { sut, response, chunks, tag } = setup();
    tag.prepare.mockResolvedValue(undefined as never);
    await sut.stream(authStub.user1, response, { types: [SyncRequestType.PinnedCollectionEventsV1] });
    expect(chunks.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
  it('routes new-type ack to exact delivery confirmation instead of generic checkpoints', async () => {
    const { sut, mocks, tag } = setup();
    await sut.setAcks(authStub.user1, { acks: ['PinnedCollectionDeleteV1|delivery-2'] });
    expect(tag.acknowledge).toHaveBeenCalledWith(authStub.user1.session!.id, {
      type: SyncEntityType.PinnedCollectionDeleteV1,
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
