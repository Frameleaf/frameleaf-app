import type { Stats } from 'node:fs';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, AssetPathType, PersonPathType } from 'src/enum.js';
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

describe('a move never replaces an original or a sidecar (FL-1333)', () => {
  const oldPath = '/upload/user/ab/cd/photo.jpg';
  const newPath = '/library/user/2024/photo.jpg';
  const staged = `${newPath}.move.moving`;
  const checksum = Buffer.alloc(20, 1);
  const assetInfo = { sizeInBytes: 64, checksum };
  const error = (code: string) => Object.assign(new Error(code), { code });

  const prepare = (pathType: AssetPathType | AssetFileType | PersonPathType = AssetPathType.Original) => {
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
    // another file, not this one under a second name
    mocks.storage.isOtherLinkOf.mockResolvedValue(false);

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    expect(mocks.storage.link).toHaveBeenCalledWith(oldPath, newPath);
    expect(mocks.storage.isOtherLinkOf).toHaveBeenCalledWith(oldPath, newPath);
    expect(mocks.storage.rename).not.toHaveBeenCalled();
    expect(mocks.storage.unlink).not.toHaveBeenCalled();
    expect(mocks.storage.copyFile).not.toHaveBeenCalled();
    // the move stays recorded: the next run resolves it
    expect(mocks.move.delete).not.toHaveBeenCalled();
    await expect(mocks.asset.moveFile.mock.results[0].value).resolves.toBe('failed');
  });

  it('does not move a sidecar onto an existing file', async () => {
    const { core, mocks } = prepare(AssetFileType.Sidecar);
    mocks.storage.link.mockRejectedValue(error('EEXIST'));
    mocks.storage.isOtherLinkOf.mockResolvedValue(false);

    await expect(core.moveFile({ entityId: 'asset', pathType: AssetFileType.Sidecar, oldPath, newPath })).resolves.toBe(
      false,
    );

    expect(mocks.storage.rename).not.toHaveBeenCalled();
    expect(mocks.storage.unlink).not.toHaveBeenCalled();
  });

  it('finishes a move an interrupted attempt linked but never unlinked', async () => {
    const { core, mocks } = prepare();
    mocks.storage.link.mockRejectedValue(error('EEXIST'));
    // the new path is this file under a second name: same device and inode, a separate entry
    mocks.storage.isOtherLinkOf.mockResolvedValue(true);

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(true);

    expect(mocks.storage.isOtherLinkOf).toHaveBeenCalledWith(oldPath, newPath);
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
    expect(mocks.storage.rename).not.toHaveBeenCalled();
    await expect(mocks.asset.moveFile.mock.results[0].value).resolves.toBe('moved');
  });

  it('keeps both names when an interrupted move cannot remove the old one', async () => {
    const { core, mocks } = prepare();
    mocks.storage.link.mockRejectedValue(error('EEXIST'));
    mocks.storage.isOtherLinkOf.mockResolvedValue(true);
    mocks.storage.unlink.mockRejectedValue(error('EACCES'));

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    // as the interrupted attempt left it: the next run tries again
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
  });

  it('finishes an interrupted move whose old name went despite an error removing it', async () => {
    const { core, mocks } = prepare();
    mocks.storage.link.mockRejectedValue(error('EEXIST'));
    mocks.storage.isOtherLinkOf
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(Object.assign(error('ENOENT'), { path: oldPath }));
    mocks.storage.unlink.mockRejectedValue(error('EIO'));

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(true);

    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
  });

  it('replaces a leftover preview, which can be made again', async () => {
    const { core, mocks } = prepare(AssetFileType.Preview);
    mocks.storage.link.mockRejectedValue(error('EEXIST'));
    mocks.storage.isOtherLinkOf.mockResolvedValue(false);

    await expect(core.moveFile({ entityId: 'asset', pathType: AssetFileType.Preview, oldPath, newPath })).resolves.toBe(
      true,
    );

    expect(mocks.storage.rename).toHaveBeenCalledWith(oldPath, newPath);
    expect(mocks.storage.unlink).not.toHaveBeenCalled();
  });

  it('replaces a leftover face thumbnail, which can be made again', async () => {
    const { core, mocks } = prepare(PersonPathType.Face);
    mocks.storage.link.mockRejectedValue(error('EEXIST'));
    mocks.storage.isOtherLinkOf.mockResolvedValue(false);

    await expect(
      core.moveFile({ entityId: 'person', ownerId: 'owner', pathType: PersonPathType.Face, oldPath, newPath }),
    ).resolves.toBe(true);

    expect(mocks.storage.rename).toHaveBeenCalledWith(oldPath, newPath);
    expect(mocks.person.update).toHaveBeenCalledWith({
      ownerId: 'owner',
      personGroupId: 'person',
      thumbnailPath: newPath,
    });
    expect(mocks.move.delete).toHaveBeenCalledWith('move');
  });

  it('renames a preview over a leftover where hard links are unsupported', async () => {
    const { core, mocks } = prepare(AssetFileType.Preview);
    mocks.storage.link.mockRejectedValue(error('ENOTSUP'));
    mocks.storage.checkFileExists.mockResolvedValue(true);

    await expect(core.moveFile({ entityId: 'asset', pathType: AssetFileType.Preview, oldPath, newPath })).resolves.toBe(
      true,
    );

    expect(mocks.storage.rename).toHaveBeenCalledWith(oldPath, newPath);
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

  it.each(['EACCES', 'EPERM', 'EROFS', 'EBUSY'])(
    'leaves the file only at its old path when the old name certainly stayed (%s)',
    async (code) => {
      const { core, mocks } = prepare();
      mocks.storage.unlink.mockImplementation((path) =>
        path === oldPath ? Promise.reject(error(code)) : Promise.resolve(),
      );
      // the old name still holds the file
      mocks.storage.isOtherLinkOf.mockResolvedValue(true);

      await expect(
        core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
      ).resolves.toBe(false);

      // only then is the link just made taken back; the file was never anywhere but the old path
      expect(mocks.storage.isOtherLinkOf).toHaveBeenCalledWith(oldPath, newPath);
      expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath], [newPath]]);
      await expect(mocks.asset.moveFile.mock.results[0].value).resolves.toBe('failed');
    },
  );

  it.each([
    ['EIO', error('EIO')],
    ['ETIMEDOUT', error('ETIMEDOUT')],
    ['EAGAIN', error('EAGAIN')],
    ['ESTALE', error('ESTALE')],
    ['ENOTCONN', error('ENOTCONN')],
    ['no code', new Error('the share went away')],
  ])(
    'keeps both names after an unclear error (%s), even when the old name seems to hold the file',
    async (_, failure) => {
      const { core, mocks } = prepare();
      mocks.storage.unlink.mockImplementation((path) =>
        path === oldPath ? Promise.reject(failure) : Promise.resolve(),
      );
      // a network share's cache can still show the old name after the server removed it
      mocks.storage.isOtherLinkOf.mockResolvedValue(true);

      await expect(
        core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
      ).resolves.toBe(false);

      // the new path may be the photo's only name: it is never removed, and the next run finishes the move
      expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
      expect(mocks.move.delete).not.toHaveBeenCalled();
      await expect(mocks.asset.moveFile.mock.results[0].value).resolves.toBe('failed');
    },
  );

  it('keeps both names when an unclear failure leaves the old name holding something else', async () => {
    const { core, mocks } = prepare();
    // a network drive that timed out: the name may be gone, or may name another file now
    mocks.storage.unlink.mockImplementation((path) =>
      path === oldPath ? Promise.reject(error('EIO')) : Promise.resolve(),
    );
    mocks.storage.isOtherLinkOf.mockResolvedValue(false);

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    // the new path may be the photo's only name: it is never removed
    expect(mocks.storage.unlink).not.toHaveBeenCalledWith(newPath);
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
  });

  it('keeps both names when it cannot tell whether the old name still holds the file', async () => {
    const { core, mocks } = prepare();
    mocks.storage.unlink.mockImplementation((path) =>
      path === oldPath ? Promise.reject(error('EIO')) : Promise.resolve(),
    );
    mocks.storage.isOtherLinkOf.mockRejectedValue(Object.assign(error('EIO'), { path: oldPath }));

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
  });

  it('counts the move as made when the old name went despite the error', async () => {
    const { core, mocks } = prepare();
    mocks.storage.unlink.mockImplementation((path) =>
      path === oldPath ? Promise.reject(error('ETIMEDOUT')) : Promise.resolve(),
    );
    // lstat of the old name: no such file
    mocks.storage.isOtherLinkOf.mockRejectedValue(Object.assign(error('ENOENT'), { path: oldPath }));

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(true);

    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
    await expect(mocks.asset.moveFile.mock.results[0].value).resolves.toBe('moved');
  });

  it('never takes back a moved file that its new path alone may hold, when putting it back', async () => {
    const { core, mocks } = prepare();
    mocks.asset.moveFile.mockImplementationOnce(async (_move, { rename, undo }) => {
      await rename();
      await undo();
      return 'failed';
    });
    // the move goes through; putting it back links the old path, then cannot tell whether the new name went
    mocks.storage.unlink.mockImplementation((path) =>
      path === newPath ? Promise.reject(error('EIO')) : Promise.resolve(),
    );
    mocks.storage.isOtherLinkOf.mockResolvedValue(false);

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    expect(mocks.storage.link.mock.calls).toEqual([
      [oldPath, newPath],
      [newPath, oldPath],
    ]);
    expect(mocks.storage.isOtherLinkOf).toHaveBeenCalledWith(newPath, oldPath);
    // the old path, linked again, is never removed on trust
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath], [newPath]]);
  });

  it('never takes back a file put back after an unclear error, even when its new name seems to hold it', async () => {
    const { core, mocks } = prepare();
    mocks.asset.moveFile.mockImplementationOnce(async (_move, { rename, undo }) => {
      await rename();
      await undo();
      return 'failed';
    });
    // putting it back links the old path, then the new name's removal times out on a network share
    mocks.storage.unlink.mockImplementation((path) =>
      path === newPath ? Promise.reject(error('ETIMEDOUT')) : Promise.resolve(),
    );
    mocks.storage.isOtherLinkOf.mockResolvedValue(true);

    await expect(
      core.moveFile({ entityId: 'asset', pathType: AssetPathType.Original, oldPath, newPath, assetInfo }),
    ).resolves.toBe(false);

    expect(mocks.storage.isOtherLinkOf).toHaveBeenCalledWith(newPath, oldPath);
    // the old path, linked again, is never removed on trust
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath], [newPath]]);
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
    expect(mocks.storage.unlink.mock.calls).toEqual([[staged]]);
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
    // a leftover copy is cleared first, quietly when there is none, then the copy is made only where nothing is
    expect(mocks.storage.unlinkIfExists.mock.calls).toEqual([[staged]]);
    expect(mocks.storage.unlinkIfExists.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.storage.copyFile.mock.invocationCallOrder[0],
    );
    expect(mocks.storage.unlink.mock.calls).toEqual([[staged], [oldPath]]);
  });

  it('replaces a leftover at the new path with a preview copied across filesystems', async () => {
    const { core, mocks } = prepare(AssetFileType.Preview);
    mocks.storage.link.mockRejectedValueOnce(error('EXDEV')).mockRejectedValueOnce(error('EEXIST'));
    mocks.storage.isOtherLinkOf.mockResolvedValue(false);
    mocks.crypto.hashFile.mockResolvedValue(Buffer.alloc(32, 1));

    await expect(core.moveFile({ entityId: 'asset', pathType: AssetFileType.Preview, oldPath, newPath })).resolves.toBe(
      true,
    );

    expect(mocks.storage.rename).toHaveBeenCalledWith(staged, newPath);
    expect(mocks.storage.unlink.mock.calls).toEqual([[oldPath]]);
  });

  it('keeps a sidecar copied across filesystems off a file already at the new path', async () => {
    const { core, mocks } = prepare(AssetFileType.Sidecar);
    mocks.storage.link.mockRejectedValueOnce(error('EXDEV')).mockRejectedValueOnce(error('EEXIST'));
    mocks.storage.isOtherLinkOf.mockResolvedValue(false);
    mocks.crypto.hashFile.mockResolvedValue(Buffer.alloc(32, 1));

    await expect(core.moveFile({ entityId: 'asset', pathType: AssetFileType.Sidecar, oldPath, newPath })).resolves.toBe(
      false,
    );

    expect(mocks.storage.rename).not.toHaveBeenCalled();
    // only the copy is removed; the source and the file at the new path stay
    expect(mocks.storage.unlink.mock.calls).toEqual([[staged]]);
  });
});
