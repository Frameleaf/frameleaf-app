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
      type: SyncEntityType.SharedSpaceV1,
      data: { id: 'tag-1', value: 'visible' },
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

describe('published shared-space link sync dispatch', () => {
  it.each([
    ['SharedSpaceAlbumsV1', 'spaceAlbum'],
    ['SharedSpacePeopleV1', 'spacePerson'],
  ] as const)('dispatches %s through current delivery preparation', async (request, kind) => {
    const { sut, response, tag } = setup();
    await sut.stream(authStub.user1, response, { types: [request as SyncRequestType] });
    expect(tag.reconcile).toHaveBeenCalledWith(authStub.user1, kind);
  });
  it.each(['SharedSpaceAlbumV1', 'SharedSpaceAlbumDeleteV1', 'SharedSpacePersonV1', 'SharedSpacePersonDeleteV1'])(
    'routes %s acknowledgement through the guarded ledger',
    async (type) => {
      const { sut, mocks, tag } = setup();
      await sut.setAcks(authStub.user1, { acks: [`${type}|delivery-1`] });
      expect(tag.acknowledge).toHaveBeenCalledWith(authStub.user1.session!.id, expect.objectContaining({ type }));
      expect(mocks.syncCheckpoint.upsertAll).not.toHaveBeenCalled();
    },
  );
});
