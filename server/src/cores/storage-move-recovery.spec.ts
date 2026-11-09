import type { Stats } from 'node:fs';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, AssetPathType } from 'src/enum.js';
import { getMocks } from 'test/utils.js';

// FL-1333: the setting is off here; a move checks a copy (and a recovered file) regardless
vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/config.js')>()),
  getConfig: vi.fn().mockResolvedValue({ storageTemplate: { hashVerificationEnabled: false } }),
}));

afterEach(() => StorageCore.reset());

const setup = () => {
  StorageCore.reset();
  const mocks = getMocks();
  const core = StorageCore.create(
    ...([
      mocks.asset,
      mocks.config,
      mocks.crypto,
      mocks.move,
      mocks.person,
      mocks.storage,
      mocks.systemMetadata,
      mocks.logger,
    ] as unknown as Parameters<typeof StorageCore.create>),
  );
  return { core, mocks };
};

it.each([
  { size: 64, matches: true, moved: true },
  { size: 63, matches: true, moved: false },
  { size: 64, matches: false, moved: false },
])(
  'recovers an already moved original only when recorded evidence matches ($size, $matches)',
  async ({ size, matches, moved }) => {
    const { core, mocks } = setup();
    const move = {
      id: 'move',
      entityId: 'asset',
      pathType: AssetPathType.Original,
      oldPath: '/old/photo.jpg',
      newPath: '/new/photo.jpg',
    };
    const checksum = Buffer.alloc(20, 1);
    mocks.move.getByEntity.mockResolvedValue(move as never);
    mocks.move.update.mockResolvedValue(move as never);
    mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === move.newPath));
    mocks.storage.stat.mockImplementation((path) => {
      if (path === move.oldPath) {
        throw Object.assign(new Error('original no longer exists here'), { code: 'ENOENT' });
      }
      return Promise.resolve({ size } as Stats);
    });
    mocks.crypto.hashFileMatching.mockResolvedValue(matches ? checksum : Buffer.alloc(20, 2));

    await expect(
      core.moveFile({
        entityId: 'asset',
        pathType: AssetPathType.Original,
        oldPath: move.oldPath,
        newPath: move.newPath,
        assetInfo: { sizeInBytes: 64, checksum },
      }),
    ).resolves.toBe(moved);
    expect(mocks.storage.stat).not.toHaveBeenCalledWith(move.oldPath);
    if (!moved) {
      expect(mocks.asset.moveFile).not.toHaveBeenCalled();
    }
  },
);

describe('a move never replaces a file (FL-1333)', () => {
  const oldPath = '/upload/user/ab/cd/photo.jpg';
  const newPath = '/library/user/2024/photo.jpg';
  const staged = `${newPath}.move.moving`;
  const checksum = Buffer.alloc(20, 1);
  const assetInfo = { sizeInBytes: 64, checksum };
  const error = (code: string) => Object.assign(new Error(code), { code });

  const prepare = (pathType: AssetPathType | AssetFileType = AssetPathType.Original) => {
    const { core, mocks } = setup();
    const move = { id: 'move', entityId: 'asset', pathType, oldPath, newPath };
    mocks.move.getByEntity.mockResolvedValue(void 0);
    mocks.move.create.mockResolvedValue(move as never);
    mocks.storage.stat.mockResolvedValue({ size: 64, atime: new Date(), mtime: new Date() } as Stats);
    mocks.crypto.hashFileMatching.mockResolvedValue(checksum);
    return { core, mocks };
  };

  it('does not move onto an existing file', async () => {
    const { core, mocks } = prepare();
    mocks.storage.link.mockRejectedValue(error('EEXIST'));

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    expect(mocks.storage.link).toHaveBeenCalledWith(oldPath, newPath);
    expect(mocks.storage.rename).not.toHaveBeenCalledWith(oldPath, newPath);
    expect(mocks.storage.rename).not.toHaveBeenCalled();
    expect(mocks.storage.unlink).not.toHaveBeenCalledWith(newPath);
    expect(mocks.storage.unlink).not.toHaveBeenCalledWith(oldPath);
    expect(mocks.storage.copyFile).not.toHaveBeenCalled();
    // the move stays recorded: the next run resolves it
    expect(mocks.move.delete).not.toHaveBeenCalled();
    await expect(mocks.asset.moveFile.mock.results[0].value).resolves.toBe('failed');
  });

  it('falls back to an exclusive check where hard links are unsupported', async () => {
    const { core, mocks } = prepare();
    mocks.storage.link.mockRejectedValue(error('ENOTSUP'));
    mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === newPath));

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    expect(mocks.storage.checkFileExists).toHaveBeenCalledWith(newPath);
    expect(mocks.storage.rename).not.toHaveBeenCalled();
    expect(mocks.storage.unlink).not.toHaveBeenCalled();
  });

  it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])(
    'renames in place where hard links are unsupported (%s) and nothing is at the new path',
    async (code) => {
      const { core, mocks } = prepare();
      mocks.storage.link.mockRejectedValue(error(code));
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(
        core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
      ).resolves.toBe(true);

      expect(mocks.storage.rename).toHaveBeenCalledWith(oldPath, newPath);
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    },
  );

  it('moves with a hard link, then removes the old name', async () => {
    const { core, mocks } = prepare();

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(true);

    expect(mocks.storage.link).toHaveBeenCalledWith(oldPath, newPath);
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
    expect(mocks.storage.rename).not.toHaveBeenCalled();
    expect(mocks.storage.link.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.storage.unlink.mock.invocationCallOrder[0],
    );
  });

  it('leaves the file only at its old path when the old name cannot be removed', async () => {
    const { core, mocks } = prepare();
    mocks.storage.unlink.mockImplementation((path) =>
      path === oldPath ? Promise.reject(error('EACCES')) : Promise.resolve(),
    );

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    // the link just made is taken back; the file was never anywhere but the old path
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath], [newPath]]);
    await expect(mocks.asset.moveFile.mock.results[0].value).resolves.toBe('failed');
  });

  it('puts a moved file back without replacing what is at its old path', async () => {
    const { core, mocks } = prepare();
    mocks.asset.moveFile.mockImplementationOnce(async (_move, { rename, undo }) => {
      await rename();
      await undo();
      return 'failed';
    });
    // something is at the old path by the time the move is put back
    mocks.storage.link.mockResolvedValueOnce(void 0).mockRejectedValueOnce(error('EEXIST'));

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    expect(mocks.storage.link.mock.calls).toEqual([
      [oldPath, newPath],
      [newPath, oldPath],
    ]);
    // the file stays at the new path, where the recorded move finds it
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
    expect(mocks.storage.rename).not.toHaveBeenCalled();
    expect(mocks.move.delete).not.toHaveBeenCalled();
  });

  it('verifies the copy even when hash verification is off', async () => {
    const { core, mocks } = prepare();
    mocks.storage.link.mockRejectedValue(error('EXDEV'));
    mocks.crypto.hashFileMatching.mockResolvedValue(Buffer.alloc(20, 2));

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    expect(mocks.storage.copyFile).toHaveBeenCalledWith(oldPath, staged, expect.any(Number));
    expect(mocks.crypto.hashFileMatching).toHaveBeenCalledWith(staged, checksum);
    expect(mocks.storage.unlink).not.toHaveBeenCalledWith(oldPath);
    expect(mocks.storage.unlink).toHaveBeenLastCalledWith(staged);
    expect(mocks.asset.moveFile).toHaveBeenCalledOnce();
  });

  it('verifies a sidecar copy by its contents', async () => {
    const { core, mocks } = prepare(AssetFileType.Sidecar);
    mocks.storage.link.mockRejectedValue(error('EXDEV'));
    mocks.crypto.hashFile.mockImplementation((path) =>
      Promise.resolve(path === oldPath ? Buffer.alloc(32, 1) : Buffer.alloc(32, 2)),
    );

    await expect(core.moveFile({ entityId: 'asset', pathType: AssetFileType.Sidecar, oldPath, newPath })).resolves.toBe(
      false,
    );

    expect(mocks.crypto.hashFile).toHaveBeenCalledWith(oldPath, 'sha256');
    expect(mocks.crypto.hashFile).toHaveBeenCalledWith(staged, 'sha256');
    expect(mocks.storage.unlink).not.toHaveBeenCalledWith(oldPath);
    expect(mocks.asset.moveFile).toHaveBeenCalledOnce();
  });

  it('moves a sidecar across filesystems when its copy matches', async () => {
    const { core, mocks } = prepare(AssetFileType.Sidecar);
    mocks.storage.link.mockRejectedValueOnce(error('EXDEV'));
    mocks.crypto.hashFile.mockResolvedValue(Buffer.alloc(32, 1));

    await expect(core.moveFile({ entityId: 'asset', pathType: AssetFileType.Sidecar, oldPath, newPath })).resolves.toBe(
      true,
    );

    expect(mocks.storage.link.mock.calls).toEqual([
      [oldPath, newPath],
      [staged, newPath],
    ]);
    // a leftover copy is cleared first, then the copy is made only where nothing is
    expect(mocks.storage.unlink.mock.calls).toEqual([[staged], [staged], [oldPath]]);
  });
});
