import { addAssetsToAlbum, createAlbum, getAllAlbums } from '@frameleaf/sdk';
import { updateAlbums } from 'src/commands/asset';

vi.mock('@frameleaf/sdk');

describe('upload album assignment', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getAllAlbums).mockResolvedValue([{ albumName: 'existing', id: 'existing-id' }] as never);
    vi.mocked(createAlbum).mockImplementation(({ createAlbumDto: album }) =>
      Promise.resolve({ albumName: album.albumName, id: 'new-id' } as never),
    );
  });

  it('groups interleaved assets and creates each missing album once', async () => {
    await updateAlbums(
      [
        { filepath: '/new/a.jpg', id: 'a' },
        { filepath: '/existing/b.jpg', id: 'b' },
        { filepath: '/new/c.jpg', id: 'c' },
        { filepath: '/existing/b.jpg', id: 'b' },
      ],
      { album: true, concurrency: 2 },
    );
    expect(createAlbum).toHaveBeenCalledExactlyOnceWith({ createAlbumDto: { albumName: 'new' } });
    expect(vi.mocked(addAssetsToAlbum).mock.calls.map(([args]) => args)).toEqual([
      { id: 'new-id', bulkIdsDto: { ids: ['a', 'c'] } },
      { id: 'existing-id', bulkIdsDto: { ids: ['b', 'b'] } },
    ]);
  });

  it('preserves explicit album names and upload batch limits', async () => {
    await updateAlbums(
      Array.from({ length: 2001 }, (_, i) => ({ filepath: `/other/${i}`, id: String(i) })),
      {
        albumName: 'existing',
        concurrency: 2,
      },
    );
    expect(createAlbum).not.toHaveBeenCalled();
    expect(vi.mocked(addAssetsToAlbum).mock.calls.map(([args]) => args.bulkIdsDto.ids.length)).toEqual([2000, 1]);
  });

  it('does not mutate albums during dry runs or after creation fails', async () => {
    const assets = [{ filepath: '/new/a.jpg', id: 'a' }];
    await updateAlbums(assets, { album: true, concurrency: 1, dryRun: true });
    expect(createAlbum).not.toHaveBeenCalled();
    expect(addAssetsToAlbum).not.toHaveBeenCalled();
    const failure = new Error('create rejected');
    vi.mocked(createAlbum).mockRejectedValue(failure);
    await expect(updateAlbums(assets, { album: true, concurrency: 1 })).rejects.toBe(failure);
    expect(addAssetsToAlbum).not.toHaveBeenCalled();
  });
});
