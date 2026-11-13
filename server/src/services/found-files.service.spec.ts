import { vi } from 'vitest';
import type { FoundFile } from 'src/repositories/found-file.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { FoundFilesService } from 'src/services/found-files.service.js';

const USER = 'a1b2c3d4-0000-4000-8000-000000000001';
const sha1 = Buffer.alloc(20, 1);
const sha256 = Buffer.alloc(32, 2);
const mtime = new Date('2026-11-01T10:00:00.000Z');
const photo = `/data/upload/${USER}/3f/9a/IMG_7731.JPG`;

const stat = (patch: Record<string, unknown> = {}) => ({
  dev: 1,
  ino: 2,
  size: 10,
  mtime,
  mtimeMs: mtime.getTime(),
  ctimeMs: mtime.getTime(),
  isFile: () => true,
  ...patch,
});

const remembered = (patch: Partial<FoundFile> = {}): FoundFile =>
  ({
    id: 'found-1',
    path: photo,
    sizeInBytes: '10',
    modifiedAt: mtime,
    sha1,
    sha256,
    outcome: 'spare',
    reason: null,
    ownerId: USER,
    assetId: 'asset-1',
    previousPath: null,
    steps: [{ step: 'found', at: '2026-11-12T03:40:00.000Z' }],
    sortedAt: new Date('2026-11-12T03:40:00.000Z'),
    ...patch,
  }) as unknown as FoundFile;

const setup = () => {
  StorageCore.setMediaLocation('/data');
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const found = { getByPaths: vi.fn().mockResolvedValue([]), upsert: vi.fn().mockResolvedValue(undefined) };
  const mediaHealth = {
    settledUntrackedFile: vi.fn().mockResolvedValue({ key: '1:2:10', size: 10, mtime }),
    placeUntrackedFile: vi.fn().mockResolvedValue({ outcome: 'added', assetId: 'new-asset' }),
  };
  const crypto = { hashFileDigests: vi.fn().mockResolvedValue({ sha1, sha256, sizeInBytes: 10 }) };
  const storage = { stat: vi.fn().mockResolvedValue(stat()) };
  const user = {
    getList: vi
      .fn()
      .mockResolvedValue([{ id: USER, storageLabel: 'taylor', quotaSizeInBytes: null, quotaUsageInBytes: 0 }]),
  };
  mediaHealth.settledUntrackedFile.mockImplementation(async (path: string) => {
    const stats = await storage.stat(path);
    return { key: [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':'), size: stats.size, mtime };
  });
  const sut = new FoundFilesService(
    logger as never,
    found as never,
    mediaHealth as never,
    crypto as never,
    storage as never,
    user as never,
  );
  const sort = async (paths: string[]) => {
    const placed: string[] = [];
    await sut.onUntrackedFound({ paths, placed });
    return placed;
  };
  return { sut, sort, found, mediaHealth, crypto, storage, user, logger };
};

describe(FoundFilesService.name, () => {
  it('reads a photo no library lists once, adds it to the account whose folder it is in, and says so', async () => {
    const { sort, found, mediaHealth, crypto } = setup();

    await expect(sort([photo])).resolves.toEqual([photo]);

    expect(crypto.hashFileDigests).toHaveBeenCalledExactlyOnceWith(photo);
    expect(mediaHealth.placeUntrackedFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: USER }),
      photo,
      mtime,
      { sha1, sha256, sizeInBytes: 10 },
      0,
    );
    expect(found.upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        path: photo,
        sizeInBytes: 10,
        modifiedAt: mtime,
        sha1,
        sha256,
        outcome: 'added',
        reason: null,
        ownerId: USER,
        assetId: 'new-asset',
      }),
    );
    expect(found.upsert.mock.calls[0][0].steps.map(({ step }: { step: string }) => step)).toEqual([
      'found',
      'read',
      'added',
    ]);
  });

  it('puts a missing photo’s file back and remembers where the photo pointed before', async () => {
    const { sort, found, mediaHealth } = setup();
    mediaHealth.placeUntrackedFile.mockResolvedValue({
      outcome: 'back',
      assetId: 'asset-1',
      previousPath: '/data/library/taylor/2020/08/IMG_3310.jpg',
    });

    await expect(sort([photo])).resolves.toEqual([photo]);

    expect(found.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'back',
        assetId: 'asset-1',
        previousPath: '/data/library/taylor/2020/08/IMG_3310.jpg',
      }),
    );
  });

  it('leaves a spare copy where it is and still lists it as a finding', async () => {
    const { sort, found, mediaHealth } = setup();
    mediaHealth.placeUntrackedFile.mockResolvedValue({ outcome: 'spare', assetId: 'asset-1' });

    await expect(sort([photo])).resolves.toEqual([]);

    expect(found.upsert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'spare', assetId: 'asset-1' }));
  });

  it('never reads an unchanged file a second time: the remembered digests answer for it', async () => {
    const { sort, found, mediaHealth, crypto } = setup();
    found.getByPaths.mockResolvedValue([remembered()]);
    mediaHealth.placeUntrackedFile.mockResolvedValue({ outcome: 'spare', assetId: 'asset-1' });

    await expect(sort([photo])).resolves.toEqual([]);

    expect(crypto.hashFileDigests).not.toHaveBeenCalled();
    expect(mediaHealth.placeUntrackedFile).toHaveBeenCalledWith(
      expect.anything(),
      photo,
      mtime,
      { sha1, sha256, sizeInBytes: 10 },
      0,
    );
    // the same file with the same answer writes nothing
    expect(found.upsert).not.toHaveBeenCalled();
  });

  it('puts a remembered spare copy back, without reading it, once the photo it copies goes missing', async () => {
    const { sort, found, mediaHealth, crypto } = setup();
    found.getByPaths.mockResolvedValue([remembered()]);
    mediaHealth.placeUntrackedFile.mockResolvedValue({
      outcome: 'back',
      assetId: 'asset-1',
      previousPath: '/gone.jpg',
    });

    await expect(sort([photo])).resolves.toEqual([photo]);

    expect(crypto.hashFileDigests).not.toHaveBeenCalled();
    expect(found.upsert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'back', previousPath: '/gone.jpg' }));
    expect(found.upsert.mock.calls[0][0].steps.map(({ step }: { step: string }) => step)).toEqual(['found', 'back']);
  });

  it('reads a remembered file again when its size or modified time changed', async () => {
    const { sort, found, crypto } = setup();
    found.getByPaths.mockResolvedValue([remembered({ sizeInBytes: '9' as never })]);

    await sort([photo]);

    expect(crypto.hashFileDigests).toHaveBeenCalledTimes(1);
  });

  it('asks a person about a file in a folder no account owns, and never adds it', async () => {
    const { sort, found, mediaHealth } = setup();
    const orphan = '/data/upload/5b2e0000-0000-4000-8000-000000000009/aa/bb/IMG_0001.jpg';
    mediaHealth.placeUntrackedFile.mockResolvedValue({ outcome: 'no-owner' });

    await expect(sort([orphan])).resolves.toEqual([]);

    expect(mediaHealth.placeUntrackedFile).toHaveBeenCalledWith(null, orphan, mtime, expect.anything(), 0);
    expect(found.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'needs', reason: 'no-owner', ownerId: null, assetId: null }),
    );
  });

  it('finds the owner of a file in an account’s sorted library folder by its storage label', async () => {
    const { sort, mediaHealth } = setup();
    const sortedPhoto = '/data/library/taylor/2022/09/DSC_0098.NEF';

    await sort([sortedPhoto]);

    expect(mediaHealth.placeUntrackedFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: USER }),
      sortedPhoto,
      mtime,
      expect.anything(),
      0,
    );
  });

  it('counts what it already added against the account’s storage limit', async () => {
    const { sort, mediaHealth } = setup();
    const second = `/data/upload/${USER}/3f/9a/IMG_7732.JPG`;

    await sort([photo, second]);

    expect(mediaHealth.placeUntrackedFile).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      second,
      mtime,
      expect.anything(),
      10,
    );
  });

  it('records an account with no room as waiting for a person', async () => {
    const { sort, found, mediaHealth } = setup();
    mediaHealth.placeUntrackedFile.mockResolvedValue({ outcome: 'over-limit' });

    await expect(sort([photo])).resolves.toEqual([]);

    expect(found.upsert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'needs', reason: 'over-limit' }));
  });

  it('remembers a file that cannot be read, and does not try it again while it is unchanged', async () => {
    const { sort, found, mediaHealth, crypto } = setup();
    crypto.hashFileDigests.mockRejectedValue(Object.assign(new Error('read failed'), { code: 'EIO' }));

    await expect(sort([photo])).resolves.toEqual([]);

    expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
    expect(found.upsert).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: 'needs', reason: 'wont-open', sha1: null, sha256: null }),
    );

    found.upsert.mockClear();
    crypto.hashFileDigests.mockClear();
    found.getByPaths.mockResolvedValue([
      remembered({ sha1: null, sha256: null, outcome: 'needs', reason: 'wont-open' }),
    ]);

    await expect(sort([photo])).resolves.toEqual([]);

    expect(crypto.hashFileDigests).not.toHaveBeenCalled();
    expect(found.upsert).not.toHaveBeenCalled();
  });

  it('leaves a file that vanished before it was read for the next check', async () => {
    const { sort, found, crypto } = setup();
    crypto.hashFileDigests.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

    await expect(sort([photo])).resolves.toEqual([]);

    expect(found.upsert).not.toHaveBeenCalled();
  });

  it('leaves a file that changed while it was read alone', async () => {
    const { sort, found, mediaHealth, storage } = setup();
    storage.stat.mockResolvedValueOnce(stat()).mockResolvedValueOnce(stat({ size: 11 }));

    await expect(sort([photo])).resolves.toEqual([]);

    expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
    expect(found.upsert).not.toHaveBeenCalled();
  });

  it('leaves a file that is still being written alone, without reading it', async () => {
    const { sort, mediaHealth, crypto } = setup();
    mediaHealth.settledUntrackedFile.mockResolvedValue(null);

    await expect(sort([photo])).resolves.toEqual([]);

    expect(crypto.hashFileDigests).not.toHaveBeenCalled();
  });

  it('sorts only photos and videos in the upload and library folders', async () => {
    const { sort, found, user, crypto } = setup();

    await expect(
      sort([
        `/data/thumbs/${USER}/ab/cd/asset_thumbnail.webp`,
        `/data/encoded-video/${USER}/ab/cd/asset.mp4`,
        `/data/upload/${USER}/3f/9a/IMG_7731.xmp`,
        `/data/upload/${USER}/3f/9a/notes.txt`,
      ]),
    ).resolves.toEqual([]);

    expect(user.getList).not.toHaveBeenCalled();
    expect(found.getByPaths).not.toHaveBeenCalled();
    expect(crypto.hashFileDigests).not.toHaveBeenCalled();
  });

  it('carries on with the next file when one fails', async () => {
    const { sort, mediaHealth, logger } = setup();
    const second = `/data/upload/${USER}/3f/9a/IMG_7732.JPG`;
    mediaHealth.placeUntrackedFile
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ outcome: 'added', assetId: 'new-asset' });

    await expect(sort([photo, second])).resolves.toEqual([second]);

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
