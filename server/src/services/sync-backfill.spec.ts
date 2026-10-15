import { Readable, Writable } from 'node:stream';
import { SyncEntityType } from 'src/enum.js';
import { SyncService } from 'src/services/sync.service.js';
import { ClientDisconnectedError } from 'src/utils/response.js';

const setup = () => {
  const albums = [
    { id: 'a', createId: '1' },
    { id: 'b', createId: '2' },
  ];
  const getCreatedAfter = vi.fn(() => Promise.resolve(albums));
  const upsertAll = vi.fn(() => Promise.resolve());
  const service = Object.assign(Object.create(SyncService.prototype), {
    syncRepository: { album: { getCreatedAfter } },
    syncCheckpointRepository: { upsertAll },
  }) as SyncService;
  const chunks: string[] = [];
  const response = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const type = SyncEntityType.AlbumUserBackfillV1;
  const context = {
    type,
    sessionId: 'session',
    checkpoint: undefined,
    end: { type: SyncEntityType.AlbumUserV1, updateId: '9' },
  };
  const options = { userId: 'user', nowId: 'now' };
  return { service, chunks, response, type, context, options, getCreatedAfter, upsertAll };
};

describe('album backfill checkpoints', () => {
  it.each([
    {
      method: 'syncAlbumUsersV1',
      repository: 'albumUser',
      backfillType: SyncEntityType.AlbumUserBackfillV1,
      endType: SyncEntityType.AlbumUserV1,
    },
    {
      method: 'syncAlbumAssetsV2',
      repository: 'albumAsset',
      backfillType: SyncEntityType.AlbumAssetBackfillV2,
      endType: SyncEntityType.AlbumAssetCreateV2,
    },
    {
      method: 'syncAlbumAssetExifsV1',
      repository: 'albumAssetExif',
      backfillType: SyncEntityType.AlbumAssetExifBackfillV1,
      endType: SyncEntityType.AlbumAssetExifCreateV1,
    },
    {
      method: 'syncAlbumToAssetsV1',
      repository: 'albumToAsset',
      backfillType: SyncEntityType.AlbumToAssetBackfillV1,
      endType: SyncEntityType.AlbumToAssetV1,
    },
  ] as const)(
    'preserves query bounds and wire acknowledgement order for $method',
    async ({ method, repository, backfillType, endType }) => {
      const { service, response, options, chunks, getCreatedAfter } = setup();
      getCreatedAfter.mockResolvedValue([{ id: 'a', createId: '1' }]);
      const empty = () => Readable.from([]);
      const getBackfill = vi.fn(() =>
        Readable.from([{ updateId: '3', id: 'asset', checksum: Buffer.from('checksum'), thumbhash: null }]),
      );
      Object.assign(service['syncRepository'], {
        [repository]: { getBackfill, getDeletes: empty, getUpserts: empty, getUpdates: empty, getCreates: empty },
      });
      await service[method](
        options,
        response,
        {
          [backfillType]: { type: backfillType, updateId: '1', extraId: '2' },
          [endType]: { type: endType, updateId: '9' },
        },
        'session',
      );
      expect(getBackfill.mock.calls[0]).toEqual([
        { ...options, afterUpdateId: '2', beforeUpdateId: '9' },
        'a',
        ...(repository === 'albumUser' ? [] : ['user']),
      ]);
      expect(chunks.map((chunk) => JSON.parse(chunk).ack)).toEqual([
        `${backfillType}|1|3`,
        `${backfillType}|1|complete`,
      ]);
      expect(JSON.parse(chunks[0]).type).toBe(backfillType);
      expect(JSON.parse(chunks[0]).data.id).toBe('asset');
    },
  );

  it('acknowledges each album only after its consumer completes', async () => {
    const { service, response, context, options, chunks, getCreatedAfter } = setup();
    const iterator = service['albumBackfills'](options, response, context);
    expect((await iterator.next()).value).toEqual({ albumId: 'a', createId: '1', startId: undefined, endId: '9' });
    expect(chunks).toEqual([]);
    expect((await iterator.next()).value).toMatchObject({ albumId: 'b' });
    expect(chunks.map((chunk) => JSON.parse(chunk).ack)).toEqual([`${context.type}|1|complete`]);
    expect((await iterator.next()).done).toBe(true);
    expect(chunks.map((chunk) => JSON.parse(chunk).ack)).toEqual([
      `${context.type}|1|complete`,
      `${context.type}|2|complete`,
    ]);
    expect(getCreatedAfter).toHaveBeenCalledWith({ ...options, afterCreateId: undefined });
  });

  it('resumes partial checkpoints and skips a completed album', async () => {
    const { service, response, context, options, type } = setup();
    const partial = service['albumBackfills'](options, response, {
      ...context,
      checkpoint: { type, updateId: '1', extraId: '3' },
    });
    expect((await partial.next()).value).toMatchObject({ albumId: 'a', startId: '3' });
    await partial.return(undefined);
    const complete = service['albumBackfills'](options, response, {
      ...context,
      checkpoint: { type, updateId: '1', extraId: 'complete' },
    });
    expect((await complete.next()).value).toMatchObject({ albumId: 'b', startId: undefined });
    await complete.return(undefined);
  });

  it('advances the checkpoint without streaming backfills on first sync', async () => {
    const { service, response, context, options, chunks, upsertAll } = setup();
    const iterator = service['albumBackfills'](options, response, { ...context, end: undefined });
    expect((await iterator.next()).done).toBe(true);
    expect(chunks).toEqual([]);
    expect(upsertAll).toHaveBeenCalledWith([
      { type: context.type, sessionId: 'session', ack: `${context.type}|2|complete` },
    ]);
  });

  it('does not acknowledge a failed consumer or disconnected response', async () => {
    const { service, response, context, options, chunks } = setup();
    const iterator = service['albumBackfills'](options, response, context);
    await iterator.next();
    await iterator.return(undefined);
    expect(chunks).toEqual([]);
    const disconnected = service['albumBackfills'](options, response, context);
    await disconnected.next();
    response.destroy();
    await expect(disconnected.next()).rejects.toBeInstanceOf(ClientDisconnectedError);
    expect(chunks).toEqual([]);
  });
});
