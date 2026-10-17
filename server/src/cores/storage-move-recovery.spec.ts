import type { Stats } from 'node:fs';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetPathType } from 'src/enum.js';
import { getMocks } from 'test/utils.js';

vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/config.js')>()),
  getConfig: vi.fn().mockResolvedValue({ storageTemplate: { hashVerificationEnabled: true } }),
}));

afterEach(() => StorageCore.reset());

it.each([
  { size: 64, matches: true, moved: true },
  { size: 63, matches: true, moved: false },
  { size: 64, matches: false, moved: false },
])(
  'recovers an already moved original only when recorded evidence matches ($size, $matches)',
  async ({ size, matches, moved }) => {
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
