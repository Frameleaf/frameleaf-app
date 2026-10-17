import { Writable } from 'node:stream';
import { AlbumUserRole, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { SyncService } from 'src/services/sync.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newTestService } from 'test/utils.js';

const rows = [
  { id: 'album-a', updateId: 'update-a', ownerId: 'owner-a', description: null, name: 'First' },
  { id: 'album-b', updateId: 'update-b', ownerId: 'owner-b', description: 'Retained', name: 'Second' },
];

function setup() {
  const { sut, mocks } = newTestService(SyncService);
  const album = {
    getDeletes: vi.fn(function* () {}),
    getUpserts: vi.fn(function* () {
      yield* rows;
    }),
    getAlbumUsers: vi.fn((id: string) =>
      Promise.resolve([{ userId: rows.find((row) => row.id === id)!.ownerId, role: AlbumUserRole.Owner }]),
    ),
  };
  mocks.sync.album = album as never;
  mocks.session.isPendingSyncReset.mockResolvedValue(false);
  mocks.syncCheckpoint.getAll.mockResolvedValue([]);
  mocks.syncCheckpoint.getNow.mockResolvedValue({ nowId: 'now-id' });
  const chunks: string[] = [];
  const response = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { sut, mocks, album, chunks, response };
}

it('projects V1 ownership in the stream query without per-album lookups and retains envelope order', async () => {
  const { sut, album, chunks, response } = setup();
  album.getDeletes.mockImplementation(function* () {
    yield { id: 'delete-id', albumId: 'removed' } as never;
  });
  await sut.stream(authStub.user1, response, { types: [SyncRequestType.AlbumsV1] });
  expect(album.getUpserts).toHaveBeenCalledWith(expect.objectContaining({ userId: authStub.user1.user.id }), true);
  expect(album.getAlbumUsers).not.toHaveBeenCalled();
  expect(chunks.map((line) => JSON.parse(line))).toEqual([
    { type: SyncEntityType.AlbumDeleteV1, ack: 'AlbumDeleteV1|delete-id', data: { albumId: 'removed' } },
    {
      type: SyncEntityType.AlbumV1,
      ack: 'AlbumV1|update-a',
      data: { id: 'album-a', ownerId: 'owner-a', description: '', name: 'First' },
    },
    {
      type: SyncEntityType.AlbumV1,
      ack: 'AlbumV1|update-b',
      data: { id: 'album-b', ownerId: 'owner-b', description: 'Retained', name: 'Second' },
    },
    { type: SyncEntityType.SyncCompleteV1, ack: 'SyncCompleteV1|now-id', data: {} },
  ]);
});

it('keeps V2 on its existing projection without requesting ownership', async () => {
  const { sut, album, chunks, response } = setup();
  await sut.stream(authStub.user1, response, { types: [SyncRequestType.AlbumsV2] });
  expect(album.getUpserts).toHaveBeenCalledWith(expect.objectContaining({ userId: authStub.user1.user.id }));
  expect(album.getAlbumUsers).not.toHaveBeenCalled();
  expect(chunks.map((line) => JSON.parse(line))).toEqual([
    {
      type: SyncEntityType.AlbumV2,
      ack: 'AlbumV2|update-a',
      data: { id: 'album-a', description: '', name: 'First' },
    },
    {
      type: SyncEntityType.AlbumV2,
      ack: 'AlbumV2|update-b',
      data: { id: 'album-b', description: 'Retained', name: 'Second' },
    },
    { type: SyncEntityType.SyncCompleteV1, ack: 'SyncCompleteV1|now-id', data: {} },
  ]);
});

it('fails rather than emitting a V1 album whose projected owner is missing', async () => {
  const { sut, album, chunks, response } = setup();
  album.getUpserts.mockImplementation(function* () {
    yield { ...rows[0], ownerId: null } as never;
  });
  await expect(sut.stream(authStub.user1, response, { types: [SyncRequestType.AlbumsV1] })).rejects.toThrow(
    'Album owner not found',
  );
  expect(chunks).toEqual([]);
});

it('does not pull the next album until output backpressure is released', async () => {
  const { sut, album } = setup();
  const pulled: string[] = [];
  let closed = false;
  album.getUpserts.mockImplementation(function* () {
    try {
      for (const row of rows) {
        pulled.push(row.id);
        yield row;
      }
    } finally {
      closed = true;
    }
  });
  let release: (() => void) | undefined;
  const chunks: string[] = [];
  const response = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      if (chunks.length === 1) {
        release = done;
      } else {
        done();
      }
    },
  });
  const pending = sut.stream(authStub.user1, response, { types: [SyncRequestType.AlbumsV1] });
  await vi.waitFor(() => expect(chunks).toHaveLength(1));
  expect(pulled).toEqual(['album-a']);
  release!();
  await pending;
  expect(pulled).toEqual(['album-a', 'album-b']);
  expect(closed).toBe(true);
});

it('closes the album iterator on client disconnect without pulling another row', async () => {
  const { sut, album } = setup();
  const pulled: string[] = [];
  let closed = false;
  album.getUpserts.mockImplementation(function* () {
    try {
      for (const row of rows) {
        pulled.push(row.id);
        yield row;
      }
    } finally {
      closed = true;
    }
  });
  const chunks: string[] = [];
  const response = new Writable({
    highWaterMark: 1,
    write(chunk) {
      chunks.push(String(chunk));
    },
  });
  const pending = sut.stream(authStub.user1, response, { types: [SyncRequestType.AlbumsV1] });
  await vi.waitFor(() => expect(chunks).toHaveLength(1));
  response.destroy();
  await pending;
  expect(pulled).toEqual(['album-a']);
  expect(closed).toBe(true);
  expect(chunks.map((line) => JSON.parse(line).type)).toEqual([SyncEntityType.AlbumV1]);
});
