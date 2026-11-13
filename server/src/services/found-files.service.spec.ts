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
  const found = {
    getByPaths: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    get: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    counts: vi.fn().mockResolvedValue([]),
    needsGroups: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    existingAssetIds: vi.fn().mockResolvedValue(new Set()),
    assetsWithoutSidecar: vi.fn().mockResolvedValue([]),
    assetsNamed: vi.fn().mockResolvedValue([]),
  };
  const asset = {
    getById: vi.fn(),
    updateAll: vi.fn().mockResolvedValue(undefined),
    upsertFile: vi.fn().mockResolvedValue(undefined),
    getByChecksumsForAnyOwner: vi.fn().mockResolvedValue([]),
  };
  const physical = {
    revertRestoredOriginal: vi.fn().mockResolvedValue(true),
    deleteUnreferencedPath: vi.fn(async (_path: string, unlink: () => Promise<void>) => {
      await unlink();
    }),
  };
  const job = { queue: vi.fn().mockResolvedValue(undefined) };
  const integrity = {
    deleteUntrackedByPaths: vi.fn().mockResolvedValue(undefined),
    getTrackedPaths: vi.fn().mockResolvedValue([]),
  };
  const mediaIntegrity = { validate: vi.fn().mockResolvedValue({ status: 'healthy' }) };
  const mediaHealth = {
    careSettings: vi.fn().mockResolvedValue({ putBackFoundFiles: true, clearGonePreviews: true }),
    settledUntrackedFile: vi.fn().mockResolvedValue({ key: '1:2:10', size: 10, mtime }),
    placeUntrackedFile: vi.fn().mockResolvedValue({ outcome: 'added', assetId: 'new-asset' }),
  };
  const crypto = { hashFileDigests: vi.fn().mockResolvedValue({ sha1, sha256, sizeInBytes: 10 }) };
  const storage = {
    stat: vi.fn().mockResolvedValue(stat()),
    unlink: vi.fn().mockResolvedValue(undefined),
    checkFileExists: vi.fn().mockResolvedValue(false),
    createZipStream: vi.fn(),
  };
  const user = {
    get: vi.fn().mockResolvedValue({ id: USER, storageLabel: 'taylor', quotaSizeInBytes: null, quotaUsageInBytes: 0 }),
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
    asset as never,
    physical as never,
    job as never,
    integrity as never,
    mediaIntegrity as never,
  );
  const sort = async (paths: string[]) => {
    const placed: string[] = [];
    await sut.onUntrackedFound({ paths, placed });
    return placed;
  };
  return {
    sut,
    sort,
    found,
    mediaHealth,
    crypto,
    storage,
    user,
    logger,
    asset,
    physical,
    job,
    integrity,
    mediaIntegrity,
  };
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
      { checkOpens: true },
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
      { checkOpens: true },
    );
    // the same file with the same answer writes nothing
    expect(found.upsert).not.toHaveBeenCalled();
  });

  it('sorts a file a search already read from what that search read, without reading it again (FL-1534)', async () => {
    const { sort, found, mediaHealth, crypto } = setup();
    found.getByPaths.mockResolvedValue([
      remembered({
        outcome: 'read',
        ownerId: null,
        assetId: null,
        steps: [],
        sortedAt: new Date('2026-11-12T03:40:00.000Z'),
      }),
    ]);
    mediaHealth.placeUntrackedFile.mockResolvedValue({ outcome: 'added', assetId: 'new-asset' });

    await expect(sort([photo])).resolves.toEqual([photo]);

    expect(crypto.hashFileDigests).not.toHaveBeenCalled();
    expect(found.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        path: photo,
        outcome: 'added',
        assetId: 'new-asset',
        ownerId: USER,
        sha1,
        sha256,
        steps: [
          expect.objectContaining({ step: 'found' }),
          { step: 'read', at: '2026-11-12T03:40:00.000Z', outcome: 'ok' },
          expect.objectContaining({ step: 'added' }),
        ],
      }),
    );
  });

  it('never shows a file that was only read by a search as a found file (FL-1534)', async () => {
    const { sut, found } = setup();
    found.get.mockResolvedValue({ ...remembered({ outcome: 'read' }), effectiveOwnerId: null });

    await expect(sut.get({ user: { id: USER } } as never, 'found-1')).rejects.toThrow('Found file not found');
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

    expect(mediaHealth.placeUntrackedFile).toHaveBeenCalledWith(null, orphan, mtime, expect.anything(), 0, {
      checkOpens: true,
    });
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
      { checkOpens: true },
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
      { checkOpens: true },
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

  describe('FL-1537', () => {
    const OTHER = '9d2f0c1e-5b6a-4c7d-8e9f-0a1b2c3d4e5f';
    const ID = '0194d6a5-7a6e-7c2a-9cb4-0a1c2d3e4f50';
    const auth = { user: { id: USER } } as never;
    const listed = (patch: Record<string, unknown> = {}) =>
      ({ ...remembered(), id: ID, effectiveOwnerId: USER, ...patch }) as never;

    it('never sorts again a file a person chose to leave', async () => {
      const { sort, found, mediaHealth, crypto } = setup();
      found.getByPaths.mockResolvedValue([remembered({ outcome: 'left' })]);
      expect(await sort([photo])).toEqual([]);
      expect(crypto.hashFileDigests).not.toHaveBeenCalled();
      expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
      expect(found.upsert).not.toHaveBeenCalled();
    });

    it('reads and remembers a file but holds it back while putting back is switched off', async () => {
      const { sort, found, mediaHealth } = setup();
      mediaHealth.careSettings.mockResolvedValue({ putBackFoundFiles: false, clearGonePreviews: true });
      expect(await sort([photo])).toEqual([]);
      expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
      expect(found.upsert).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: 'needs', reason: 'asked', sha256 }),
      );
    });

    it('lists a file that does not decode as one that won’t open', async () => {
      const { sort, found, mediaHealth } = setup();
      mediaHealth.placeUntrackedFile.mockResolvedValue({ outcome: 'wont-open' });
      expect(await sort([photo])).toEqual([]);
      expect(found.upsert).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'needs', reason: 'wont-open' }));
    });

    describe('tidying', () => {
      const GONE = '11111111-2222-4333-8444-555555555555';
      const HERE = '66666666-7777-4888-9999-aaaaaaaaaaaa';
      const gone = `/data/thumbs/${USER}/11/11/${GONE}_preview.jpeg`;
      const video = `/data/encoded-video/${USER}/11/11/${GONE}.mp4`;
      const here = `/data/thumbs/${USER}/66/66/${HERE}_thumbnail.webp`;

      it('clears the previews of photos that are gone, and keeps every other file', async () => {
        const { sort, found, storage, physical } = setup();
        found.existingAssetIds.mockResolvedValue(new Set([HERE]));
        const unknown = `/data/thumbs/${USER}/notes.txt`;
        // named after a person, not a photo: a face picture is never taken for a photo's preview
        const face = `/data/thumbs/${USER}/11/11/${GONE}.jpeg`;
        expect(await sort([gone, video, here, unknown, face])).toEqual([gone, video]);
        expect(physical.deleteUnreferencedPath).toHaveBeenCalledTimes(2);
        expect(storage.unlink.mock.calls.map(([path]) => path)).toEqual([gone, video]);
        expect(found.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ path: gone, outcome: 'tidied', reason: 'preview', assetId: GONE }),
        );
      });

      it('keeps a preview that was written moments ago: its photo may still be arriving', async () => {
        const { sort, storage, mediaHealth } = setup();
        mediaHealth.settledUntrackedFile.mockResolvedValue(null);
        expect(await sort([gone])).toEqual([]);
        expect(storage.unlink).not.toHaveBeenCalled();
      });

      it('clears nothing when clearing previews is switched off', async () => {
        const { sort, storage, mediaHealth } = setup();
        mediaHealth.careSettings.mockResolvedValue({ putBackFoundFiles: true, clearGonePreviews: false });
        expect(await sort([gone, video])).toEqual([]);
        expect(storage.unlink).not.toHaveBeenCalled();
      });

      it('joins an XMP file to the photo of the same name that has none', async () => {
        const { sort, found, asset, job, storage } = setup();
        const xmp = `${photo}.xmp`;
        const lone = `/data/upload/${USER}/3f/9a/other.jpg.xmp`;
        found.assetsWithoutSidecar.mockResolvedValue([{ id: 'asset-1', originalPath: photo }]);
        expect(await sort([xmp, lone])).toEqual([xmp]);
        expect(found.assetsWithoutSidecar).toHaveBeenCalledWith([photo, lone.slice(0, -4)]);
        expect(asset.upsertFile).toHaveBeenCalledExactlyOnceWith({ assetId: 'asset-1', type: 'sidecar', path: xmp });
        expect(job.queue).toHaveBeenCalledWith({ name: 'SidecarCheck', data: { id: 'asset-1' } });
        expect(found.upsert).toHaveBeenCalledWith(
          expect.objectContaining({ path: xmp, outcome: 'tidied', reason: 'sidecar' }),
        );
        expect(storage.unlink).not.toHaveBeenCalled();
      });

      describe('FL-1579: an XMP file named photo.xmp', () => {
        const folder = `/data/upload/${USER}/3f/9a`;
        const xmp = `${folder}/IMG_7731.xmp`;
        const stem = `${folder}/IMG_7731`;

        it('is joined to the one photo in its folder with that name', async () => {
          const { sort, found, asset, job } = setup();
          found.assetsNamed.mockResolvedValue([{ id: 'asset-1', originalPath: photo, stem, hasSidecar: false }]);
          expect(await sort([xmp])).toEqual([xmp]);
          const [stems, endings] = found.assetsNamed.mock.calls[0];
          expect(stems).toEqual([stem]);
          expect(endings).toEqual(expect.arrayContaining(['.jpg', '.JPG', '.heic', '.MOV']));
          expect(asset.upsertFile).toHaveBeenCalledExactlyOnceWith({ assetId: 'asset-1', type: 'sidecar', path: xmp });
          expect(job.queue).toHaveBeenCalledWith({ name: 'SidecarCheck', data: { id: 'asset-1' } });
          expect(found.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ path: xmp, outcome: 'tidied', reason: 'sidecar', assetId: 'asset-1' }),
          );
        });

        it('is left alone when two photos in the folder have that name', async () => {
          const { sort, found, asset } = setup();
          found.assetsNamed.mockResolvedValue([
            { id: 'asset-1', originalPath: photo, stem, hasSidecar: false },
            { id: 'asset-2', originalPath: `${stem}.MOV`, stem, hasSidecar: false },
          ]);
          expect(await sort([xmp])).toEqual([]);
          expect(asset.upsertFile).not.toHaveBeenCalled();
        });

        it('is left alone when the photo has an XMP file of its own', async () => {
          const { sort, found, asset } = setup();
          found.assetsNamed.mockResolvedValue([{ id: 'asset-1', originalPath: photo, stem, hasSidecar: true }]);
          expect(await sort([xmp])).toEqual([]);
          expect(asset.upsertFile).not.toHaveBeenCalled();
        });

        it('is not looked for when photo.jpg.xmp was joined, or the name already ends like a photo', async () => {
          const { sort, found } = setup();
          const full = `${photo}.xmp`;
          const lone = `${folder}/other.jpg.xmp`;
          found.assetsWithoutSidecar.mockResolvedValue([{ id: 'asset-1', originalPath: photo }]);
          expect(await sort([full, lone])).toEqual([full]);
          expect(found.assetsNamed).not.toHaveBeenCalled();
        });

        it('asks the database a few hundred names at a time', async () => {
          const { sort, found } = setup();
          await sort(Array.from({ length: 450 }, (_, index) => `${folder}/IMG_${index}.xmp`));
          expect(found.assetsNamed.mock.calls.map(([stems]) => stems.length)).toEqual([200, 200, 50]);
        });
      });
    });

    describe('review', () => {
      it('adds up the outcomes, what was tidied and the groups that wait', async () => {
        const { sut, found } = setup();
        found.counts.mockResolvedValue([
          { outcome: 'back', reason: null, count: 3, sizeInBytes: 30 },
          { outcome: 'spare', reason: null, count: 2, sizeInBytes: 20 },
          { outcome: 'needs', reason: 'no-owner', count: 4, sizeInBytes: 40 },
          { outcome: 'needs', reason: 'wont-open', count: 1, sizeInBytes: 1 },
          { outcome: 'tidied', reason: 'preview', count: 9, sizeInBytes: 90 },
          { outcome: 'tidied', reason: 'sidecar', count: 5, sizeInBytes: 5 },
        ]);
        found.needsGroups.mockResolvedValue([
          { reason: 'no-owner', ownerId: null, folder: '/data/upload/5b2e', count: 4, sizeInBytes: 40 },
        ]);
        await expect(sut.getSummary()).resolves.toEqual({
          back: 3,
          added: 0,
          spare: 2,
          spareSizeInBytes: 20,
          needs: 5,
          left: 0,
          tidied: { previews: 9, previewSizeInBytes: 90, sidecars: 5 },
          groups: [{ reason: 'no-owner', ownerId: null, folder: '/data/upload/5b2e', count: 4, sizeInBytes: 40 }],
        });
      });

      it('marks another account’s file as not to be shown, and refuses to send it', async () => {
        const { sut, found } = setup();
        found.list.mockResolvedValue([
          listed(),
          listed({ effectiveOwnerId: OTHER }),
          listed({ effectiveOwnerId: null }),
        ]);
        const { items } = await sut.list(auth, { outcome: 'spare' });
        expect(items.map(({ viewable }) => viewable)).toEqual([true, false, true]);

        found.get.mockResolvedValue(listed({ effectiveOwnerId: OTHER }));
        await expect(sut.getFile(auth, ID)).rejects.toThrow('another account');
        await expect(sut.undo(auth, ID)).rejects.toThrow('another account');
        found.get.mockResolvedValue(listed());
        await expect(sut.getFile(auth, ID)).resolves.toEqual(expect.objectContaining({ path: photo }));
      });

      it('does not list a tidied file as a found file', async () => {
        const { sut, found } = setup();
        found.get.mockResolvedValue(listed({ outcome: 'tidied', reason: 'preview' }));
        await expect(sut.get(auth, ID)).rejects.toThrow('not found');
      });
    });

    describe('undo', () => {
      it('points a photo that was put back at its old path again and leaves the file alone', async () => {
        const { sut, found, physical, storage } = setup();
        found.get.mockResolvedValue(listed({ outcome: 'back', previousPath: '/data/library/taylor/IMG_3310.jpg' }));
        await sut.undo(auth, ID);
        expect(physical.revertRestoredOriginal).toHaveBeenCalledExactlyOnceWith({
          assetId: 'asset-1',
          foundPath: photo,
          previousPath: '/data/library/taylor/IMG_3310.jpg',
        });
        expect(found.upsert).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            path: photo,
            outcome: 'left',
            steps: expect.arrayContaining([expect.objectContaining({ step: 'undone', facts: { was: 'back' } })]),
          }),
        );
        expect(found.upsert.mock.calls[0][0]).not.toHaveProperty('id');
        expect(storage.unlink).not.toHaveBeenCalled();
      });

      it('says so when the photo has changed since', async () => {
        const { sut, found, physical } = setup();
        found.get.mockResolvedValue(listed({ outcome: 'back', previousPath: '/data/library/taylor/IMG_3310.jpg' }));
        physical.revertRestoredOriginal.mockResolvedValue(false);
        await expect(sut.undo(auth, ID)).rejects.toThrow('changed since');
        expect(found.upsert).not.toHaveBeenCalled();
      });

      it('takes an added photo out of the library and keeps its file on the drive', async () => {
        const { sut, found, asset, job, storage } = setup();
        found.get.mockResolvedValue(listed({ outcome: 'added' }));
        asset.getById.mockResolvedValue({ id: 'asset-1', originalPath: photo });
        await sut.undo(auth, ID);
        expect(asset.updateAll).toHaveBeenCalledWith(['asset-1'], expect.objectContaining({ status: 'deleted' }));
        expect(job.queue).toHaveBeenCalledExactlyOnceWith({
          name: 'AssetDelete',
          data: { id: 'asset-1', deleteOnDisk: false },
        });
        expect(found.upsert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ path: photo, outcome: 'left' }));
        expect(storage.unlink).not.toHaveBeenCalled();
      });

      it('leaves the file alone where the photo’s file was moved to', async () => {
        const { sut, found, asset } = setup();
        const moved = '/data/library/taylor/2018/08/IMG_7731.JPG';
        found.get.mockResolvedValue(listed({ outcome: 'added' }));
        asset.getById.mockResolvedValue({ id: 'asset-1', originalPath: moved });
        await sut.undo(auth, ID);
        expect(found.upsert.mock.calls.map(([row]) => [row.path, row.outcome])).toEqual([
          [moved, 'left'],
          [photo, 'left'],
        ]);
      });

      it('has nothing to undo for a spare copy', async () => {
        const { sut, found } = setup();
        found.get.mockResolvedValue(listed({ outcome: 'spare' }));
        await expect(sut.undo(auth, ID)).rejects.toThrow('Nothing was done');
      });

      it('FL-1579: answers with the file that is left on the drive when the photo’s file was moved', async () => {
        const { sut, found, asset } = setup();
        const moved = '/data/library/taylor/2018/08/IMG_7731.JPG';
        const MOVED_ID = '0194d6a5-7a6e-7c2a-9cb4-0a1c2d3e4f77';
        found.get.mockImplementation((id: string) =>
          Promise.resolve(
            id === MOVED_ID ? listed({ id: MOVED_ID, path: moved, outcome: 'left' }) : listed({ outcome: 'added' }),
          ),
        );
        found.getByPaths.mockResolvedValue([remembered({ id: MOVED_ID, path: moved, outcome: 'left' })]);
        asset.getById.mockResolvedValue({ id: 'asset-1', originalPath: moved });
        await expect(sut.undo(auth, ID)).resolves.toEqual(expect.objectContaining({ id: MOVED_ID, path: moved }));
        expect(found.getByPaths).toHaveBeenCalledWith([moved]);
      });
    });

    describe('FL-1579: sorting a left file again', () => {
      const left = (patch: Record<string, unknown> = {}) =>
        listed({ outcome: 'left', steps: [{ step: 'undone', at: '2026-11-12T04:00:00.000Z' }], ...patch });

      it('places the file as a new one would be, from the contents that were read, and says so', async () => {
        const { sut, found, mediaHealth, crypto, integrity, user } = setup();
        found.get.mockResolvedValue(left({ assetId: null }));
        await sut.sortAgain(auth, ID);
        expect(crypto.hashFileDigests).not.toHaveBeenCalled();
        expect(user.get).toHaveBeenCalledWith(USER, {});
        expect(mediaHealth.placeUntrackedFile).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ id: USER }),
          photo,
          mtime,
          { sha1, sha256, sizeInBytes: 10 },
          0,
          { checkOpens: true },
        );
        expect(found.upsert).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            path: photo,
            outcome: 'added',
            reason: null,
            assetId: 'new-asset',
            steps: [
              expect.objectContaining({ step: 'undone' }),
              expect.objectContaining({ step: 'again' }),
              expect.objectContaining({ step: 'added' }),
            ],
          }),
        );
        expect(found.upsert.mock.calls[0][0]).not.toHaveProperty('id');
        expect(integrity.deleteUntrackedByPaths).toHaveBeenCalledExactlyOnceWith([photo]);
      });

      it('puts it back under the photo that is missing again, with where that photo pointed', async () => {
        const { sut, found, mediaHealth } = setup();
        found.get.mockResolvedValue(left());
        mediaHealth.placeUntrackedFile.mockResolvedValue({
          outcome: 'back',
          assetId: 'asset-1',
          previousPath: '/data/library/taylor/IMG_3310.jpg',
        });
        await sut.sortAgain(auth, ID);
        expect(found.upsert).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            outcome: 'back',
            assetId: 'asset-1',
            previousPath: '/data/library/taylor/IMG_3310.jpg',
          }),
        );
      });

      it('lets a file that still cannot be added wait, and keeps it on the list of files in no library', async () => {
        const { sut, found, mediaHealth, integrity } = setup();
        found.get.mockResolvedValue(left({ assetId: null }));
        mediaHealth.placeUntrackedFile.mockResolvedValue({ outcome: 'over-limit' });
        await sut.sortAgain(auth, ID);
        expect(found.upsert).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ outcome: 'needs', reason: 'over-limit', assetId: null }),
        );
        expect(integrity.deleteUntrackedByPaths).not.toHaveBeenCalled();
      });

      it('is only for a file that was left alone', async () => {
        const { sut, found, mediaHealth } = setup();
        found.get.mockResolvedValue(listed({ outcome: 'spare' }));
        await expect(sut.sortAgain(auth, ID)).rejects.toThrow('left alone');
        expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
      });

      it('refuses another account’s file', async () => {
        const { sut, found, mediaHealth } = setup();
        found.get.mockResolvedValue(left({ effectiveOwnerId: OTHER }));
        await expect(sut.sortAgain(auth, ID)).rejects.toThrow('another account');
        expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
      });

      it('refuses a file that changed since it was read', async () => {
        const { sut, found, storage, mediaHealth } = setup();
        found.get.mockResolvedValue(left());
        storage.stat.mockResolvedValue(stat({ size: 11 }));
        await expect(sut.sortAgain(auth, ID)).rejects.toThrow('changed or is gone');
        expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
      });

      it('waits while the photo it was is still leaving the library', async () => {
        const { sut, found, asset, mediaHealth } = setup();
        found.get.mockResolvedValue(left());
        asset.getById.mockResolvedValue({ id: 'asset-1', status: 'deleted' });
        await expect(sut.sortAgain(auth, ID)).rejects.toThrow('still leaving');
        expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
      });
    });

    describe('FL-1579: downloading the files that won’t open', () => {
      const broken = (name: string, patch: Record<string, unknown> = {}) =>
        listed({
          id: name,
          path: `/data/upload/${USER}/3f/9a/${name}`,
          outcome: 'needs',
          reason: 'wont-open',
          assetId: null,
          ...patch,
        });
      const zip = () => {
        const archive = {
          stream: { destroy: vi.fn() },
          addFile: vi.fn(),
          finalize: vi.fn().mockResolvedValue(undefined),
        };
        return archive;
      };

      it('sends the files the person asking may see, each under a name of its own', async () => {
        const { sut, found, storage } = setup();
        const archive = zip();
        storage.createZipStream.mockReturnValue(archive);
        storage.checkFileExists.mockResolvedValue(true);
        found.list.mockResolvedValue([
          broken('a.jpg'),
          broken('theirs.jpg', { effectiveOwnerId: OTHER }),
          broken('a.jpg', { path: `/data/upload/${USER}/00/11/a.jpg` }),
          broken('nobody.jpg', { effectiveOwnerId: null }),
        ]);
        await expect(sut.downloadWontOpen(auth, { ownerId: USER })).resolves.toBe(archive.stream);
        expect(found.list).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ outcome: 'needs', reason: 'wont-open', ownerId: USER, folder: undefined }),
        );
        expect(archive.addFile.mock.calls).toEqual([
          [`/data/upload/${USER}/3f/9a/a.jpg`, 'a.jpg'],
          [`/data/upload/${USER}/00/11/a.jpg`, 'a+1.jpg'],
          [`/data/upload/${USER}/3f/9a/nobody.jpg`, 'nobody.jpg'],
        ]);
        expect(archive.finalize).toHaveBeenCalledOnce();
        // the file check never asks about another account's file
        expect(storage.checkFileExists.mock.calls.map(([path]) => path)).not.toContain(
          `/data/upload/${USER}/3f/9a/theirs.jpg`,
        );
      });

      it('leaves out a file that cannot be read, and says so when none can be sent', async () => {
        const { sut, found, storage } = setup();
        storage.checkFileExists.mockResolvedValue(false);
        found.list.mockResolvedValue([broken('a.jpg')]);
        await expect(sut.downloadWontOpen(auth, {})).rejects.toThrow('None of these files');
        expect(storage.createZipStream).not.toHaveBeenCalled();
      });
    });

    describe('decisions', () => {
      const orphan = '/data/upload/5b2e/3f/9a/IMG_0001.jpg';
      const waiting = (patch: Record<string, unknown> = {}) =>
        listed({ path: orphan, outcome: 'needs', reason: 'no-owner', ownerId: null, assetId: null, ...patch });

      it('needs the folder and the account for files no account owns', async () => {
        const { sut } = setup();
        await expect(sut.resolve({ reason: 'no-owner' })).rejects.toThrow('Choose the folder');
        await expect(sut.resolve({ reason: 'no-owner', folder: '/data/upload/5b2e', ownerId: OTHER })).rejects.toThrow(
          'not on this server',
        );
      });

      it('adds a folder’s files to the chosen account without reading them again', async () => {
        const { sut, found, mediaHealth, crypto, integrity } = setup();
        found.list.mockResolvedValue([waiting()]);
        const result = await sut.resolve({ reason: 'no-owner', folder: '/data/upload/5b2e', ownerId: USER });
        expect(found.list).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'needs', reason: 'no-owner', folder: '/data/upload/5b2e' }),
        );
        expect(crypto.hashFileDigests).not.toHaveBeenCalled();
        expect(mediaHealth.placeUntrackedFile).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ id: USER }),
          orphan,
          mtime,
          { sha1, sha256, sizeInBytes: 10 },
          0,
          { ignoreQuota: false, checkOpens: true },
        );
        expect(found.upsert).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            path: orphan,
            outcome: 'added',
            reason: null,
            ownerId: USER,
            assetId: 'new-asset',
          }),
        );
        expect(integrity.deleteUntrackedByPaths).toHaveBeenCalledWith([orphan]);
        expect(result).toEqual({ back: 0, added: 1, spare: 0, waiting: 0, skipped: 0, nextCursor: null });
      });

      it('adds over an account’s storage limit only when told to', async () => {
        const { sut, found, mediaHealth } = setup();
        found.list.mockResolvedValue([waiting({ reason: 'over-limit', ownerId: USER })]);
        await sut.resolve({ reason: 'over-limit', ownerId: USER });
        expect(mediaHealth.placeUntrackedFile.mock.calls[0][5]).toEqual({ ignoreQuota: true, checkOpens: true });
      });

      it('skips a file that changed since it was read', async () => {
        const { sut, found, mediaHealth, storage } = setup();
        found.list.mockResolvedValue([waiting()]);
        storage.stat.mockResolvedValue(stat({ size: 11 }));
        const result = await sut.resolve({ reason: 'no-owner', folder: '/data/upload/5b2e', ownerId: USER });
        expect(mediaHealth.placeUntrackedFile).not.toHaveBeenCalled();
        expect(result.skipped).toBe(1);
      });
    });

    describe('deleting spare copies', () => {
      const original = '/data/library/taylor/2019/03/IMG_2041.jpg';
      const copy = { id: 'asset-1', deletedAt: null, status: 'active', originalPath: original };

      it('deletes a copy once the photo it copies is read again and opens', async () => {
        const { sut, found, asset, mediaIntegrity, storage, integrity } = setup();
        found.list.mockResolvedValue([listed()]);
        asset.getByChecksumsForAnyOwner.mockResolvedValue([copy]);
        const result = await sut.deleteSpares({});
        expect(mediaIntegrity.validate).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ path: original, deep: true, expected: { sha1, sha256, sizeInBytes: 10 } }),
        );
        expect(storage.unlink).toHaveBeenCalledExactlyOnceWith(photo);
        expect(found.delete).toHaveBeenCalledWith(ID);
        expect(integrity.deleteUntrackedByPaths).toHaveBeenCalledWith([photo]);
        expect(result).toEqual({ deleted: 1, freedBytes: 10, kept: 0, nextCursor: null });
      });

      it.each([
        [
          'the photo it copies does not open',
          (mocks: ReturnType<typeof setup>) => mocks.mediaIntegrity.validate.mockResolvedValue({ status: 'corrupt' }),
        ],
        [
          'no photo in a library has its contents',
          (mocks: ReturnType<typeof setup>) => mocks.asset.getByChecksumsForAnyOwner.mockResolvedValue([]),
        ],
        [
          'the only photo with its contents is in the Trash',
          (mocks: ReturnType<typeof setup>) =>
            mocks.asset.getByChecksumsForAnyOwner.mockResolvedValue([
              { ...copy, deletedAt: new Date(), status: 'trashed' },
            ]),
        ],
        [
          'a photo uses this very file now',
          (mocks: ReturnType<typeof setup>) => mocks.integrity.getTrackedPaths.mockResolvedValue([{ path: photo }]),
        ],
        [
          'the copy changed since it was read',
          (mocks: ReturnType<typeof setup>) => mocks.storage.stat.mockResolvedValue(stat({ size: 11 })),
        ],
      ])('keeps a copy when %s', async (_name, arrange) => {
        const mocks = setup();
        mocks.found.list.mockResolvedValue([listed()]);
        mocks.asset.getByChecksumsForAnyOwner.mockResolvedValue([copy]);
        arrange(mocks);
        const result = await mocks.sut.deleteSpares({});
        expect(mocks.storage.unlink).not.toHaveBeenCalled();
        expect(mocks.found.delete).not.toHaveBeenCalled();
        expect(result).toEqual({ deleted: 0, freedBytes: 0, kept: 1, nextCursor: null });
      });
    });
  });
});
