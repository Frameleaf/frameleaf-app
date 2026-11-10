import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';
import { isFileRootReachable, unreachableRoots } from 'src/utils/storage-reach.js';

const gone = () => Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }));
const statWithout = (...missing: string[]) => ({
  stat: (path: string) => (missing.includes(path) ? gone() : Promise.resolve({})),
});

describe('storage reach (FL-520, FL-1337)', () => {
  const libraries = [{ name: 'Photos', importPaths: ['/mnt/photos/'] }];
  let upload: string;
  beforeAll(() => {
    StorageCore.setMediaLocation('/data');
    upload = StorageCore.getBaseFolder(StorageFolder.Upload);
  });

  it('says a file is unreachable only when the root it lives under is gone', async () => {
    const unplugged = statWithout(`${upload}/.frameleaf`, '/mnt/photos/');
    await expect(isFileRootReachable(unplugged, `${upload}/user/ab/cd/photo.jpg`, libraries)).resolves.toBe(false);
    await expect(isFileRootReachable(unplugged, '/mnt/photos/2019/photo.jpg', libraries)).resolves.toBe(false);
    await expect(isFileRootReachable(statWithout(), `${upload}/user/photo.jpg`, libraries)).resolves.toBe(true);
    // a file under no root says nothing about any drive
    await expect(isFileRootReachable(unplugged, '/elsewhere/photo.jpg', libraries)).resolves.toBe(true);
  });

  it('lets the most specific root decide', async () => {
    const nested = [{ name: 'Inside upload', importPaths: [`${upload}/shared`] }];
    const stat = statWithout(`${upload}/.frameleaf`);
    await expect(isFileRootReachable(stat, `${upload}/shared/photo.jpg`, nested)).resolves.toBe(true);
    await expect(isFileRootReachable(stat, `${upload}/user/photo.jpg`, nested)).resolves.toBe(false);
  });

  it('counts a failure the filesystem does not explain as reachable', async () => {
    const failing = { stat: () => Promise.reject(Object.assign(new Error('busy'), { code: 'EIO' })) };
    await expect(isFileRootReachable(failing, `${upload}/user/photo.jpg`, libraries)).resolves.toBe(true);
    await expect(unreachableRoots(failing, libraries)).resolves.toEqual([]);
  });

  it('lists the unreachable roots, trimmed, in their kept order', async () => {
    await expect(unreachableRoots(statWithout(`${upload}/.frameleaf`, '/mnt/photos/'), libraries)).resolves.toEqual([
      { kind: 'storage', name: '', path: upload, probe: `${upload}/.frameleaf` },
      { kind: 'library', name: 'Photos', path: '/mnt/photos', probe: '/mnt/photos/' },
    ]);
  });
});
