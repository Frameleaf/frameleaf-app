import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EagleLibraryRepository, EagleListingUnavailableError } from 'src/repositories/eagle-library.repository.js';

// Folders are listed only through a checked handle (`/proc/self/fd`), so the listing tests run where
// Frameleaf runs: on Linux. Elsewhere the repository refuses to list, which is tested below.
const linux = process.platform === 'linux';
const onLinux = it.runIf(linux);

describe(EagleLibraryRepository.name, () => {
  let root: string;
  let outside: string;
  const sut = new EagleLibraryRepository();

  const library = async (relative: string) => {
    const folder = path.join(root, relative);
    await mkdir(path.join(folder, 'images', 'I1.info'), { recursive: true });
    await writeFile(path.join(folder, 'metadata.json'), JSON.stringify({ folders: [] }));
    await writeFile(path.join(folder, 'images', 'I1.info', 'metadata.json'), JSON.stringify({ id: 'I1', name: 'a' }));
    await writeFile(path.join(folder, 'images', 'I1.info', 'a.jpg'), 'bytes');
    return folder;
  };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'eagle-root-'));
    outside = await mkdtemp(path.join(tmpdir(), 'eagle-outside-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  onLinux('lists .library folders a few levels down, without following links or opening hidden folders', async () => {
    await library('Design/Eagle/Studio References.library');
    await library('Top.library');
    await library('.hidden/Secret.library');
    await library('a/b/c/d/e/Too Deep.library');
    await mkdir(path.join(root, 'Not a library.library'));
    await mkdir(path.join(outside, 'Elsewhere.library'), { recursive: true });
    await writeFile(path.join(outside, 'Elsewhere.library', 'metadata.json'), '{}');
    await symlink(outside, path.join(root, 'link'));
    await expect(sut.findLibraries(root)).resolves.toEqual(['Design/Eagle/Studio References.library', 'Top.library']);
  });

  onLinux('reads the item folders and their file names, never a linked file', async () => {
    const folder = await library('Studio.library');
    await mkdir(path.join(folder, 'images', 'I2.info'));
    await writeFile(path.join(folder, 'images', 'I2.info', 'metadata.json'), '{ not json');
    await writeFile(path.join(outside, 'secret.jpg'), 'secret');
    await symlink(path.join(outside, 'secret.jpg'), path.join(folder, 'images', 'I2.info', 'b.jpg'));
    const folders = await sut.readInfoFolders(folder);
    expect(folders).toEqual([
      { id: 'I1', metadata: { id: 'I1', name: 'a' }, fileNames: expect.arrayContaining(['metadata.json', 'a.jpg']) },
      { id: 'I2', metadata: undefined, fileNames: ['metadata.json'] },
    ]);
    await expect(sut.readLibraryMetadata(folder)).resolves.toEqual({ folders: [] });
    const opened = await sut.openItemFile(folder, 'I1', 'a.jpg');
    expect(opened).toMatchObject({ size: 5 });
    await opened!.handle.close();
    await expect(sut.openItemFile(folder, 'I2', 'b.jpg')).resolves.toBeUndefined();
  });

  onLinux('lists a folder through the handle it checked, so a folder swapped for a link is never listed', async () => {
    const folder = await library('Studio.library');
    await mkdir(path.join(outside, 'images', 'X.info'), { recursive: true });
    await writeFile(path.join(outside, 'images', 'X.info', 'metadata.json'), JSON.stringify({ id: 'X' }));
    await writeFile(path.join(outside, 'images', 'X.info', 'secret.jpg'), 'secret');
    class Swapping extends EagleLibraryRepository {
      constructor() {
        super();
        this.afterDirectoryCheck = async (directory) => {
          if (directory.endsWith(`${path.sep}images`)) {
            this.afterDirectoryCheck = undefined;
            await rename(directory, `${directory}-old`);
            await symlink(path.join(outside, 'images'), directory);
          }
        };
      }
    }
    const folders = await new Swapping().readInfoFolders(folder);
    expect(folders.map(({ id }) => id)).not.toContain('X');
    expect(JSON.stringify(folders)).not.toContain('secret');
  });

  onLinux('never walks into a folder swapped for a link while looking for libraries', async () => {
    await library('Design/Studio.library');
    await mkdir(path.join(outside, 'Elsewhere.library'), { recursive: true });
    await writeFile(path.join(outside, 'Elsewhere.library', 'metadata.json'), '{}');
    class Swapping extends EagleLibraryRepository {
      constructor() {
        super();
        this.afterDirectoryCheck = async (directory) => {
          if (directory.endsWith(`${path.sep}Design`)) {
            this.afterDirectoryCheck = undefined;
            await rename(directory, `${directory}-old`);
            await symlink(outside, directory);
          }
        };
      }
    }
    const found = await new Swapping().findLibraries(root);
    expect(found.some((relative) => relative.includes('Elsewhere'))).toBe(false);
  });

  it.skipIf(linux)('refuses to list folders where it can’t list through the checked handle', async () => {
    const folder = await library('Studio.library');
    await expect(sut.isAvailable()).resolves.toBe(false);
    await expect(sut.findLibraries(root)).rejects.toBeInstanceOf(EagleListingUnavailableError);
    await expect(sut.readInfoFolders(folder)).rejects.toBeInstanceOf(EagleListingUnavailableError);
  });

  it('never falls back to listing by name when the handle can’t be listed', async () => {
    const folder = await library('Studio.library');
    class NoHandleListing extends EagleLibraryRepository {
      protected override listOpenDirectory(): Promise<never> {
        return Promise.reject(new EagleListingUnavailableError());
      }
    }
    await expect(new NoHandleListing().readInfoFolders(folder)).rejects.toBeInstanceOf(EagleListingUnavailableError);
    await expect(new NoHandleListing().findLibraries(root)).rejects.toBeInstanceOf(EagleListingUnavailableError);
  });

  onLinux('opens an item file only by plain names, inside the library, never through a link', async () => {
    const folder = await library('Studio.library');
    await mkdir(path.join(outside, 'X.info'));
    await writeFile(path.join(outside, 'X.info', 'a.jpg'), 'secret');
    // A folder name or file name that would leave the library.
    await expect(sut.openItemFile(folder, '../../../outside', 'a.jpg')).resolves.toBeUndefined();
    await expect(sut.openItemFile(folder, 'I1', '../../metadata.json')).resolves.toBeUndefined();
    // An item folder that is a link to somewhere else.
    await symlink(path.join(outside, 'X.info'), path.join(folder, 'images', 'S.info'));
    await expect(sut.openItemFile(folder, 'S', 'a.jpg')).resolves.toBeUndefined();
    expect((await sut.readInfoFolders(folder)).map(({ id }) => id)).toEqual(['I1']);
    // A metadata.json swapped for a link is never read.
    await writeFile(path.join(outside, 'metadata.json'), JSON.stringify({ id: 'secret' }));
    await rm(path.join(folder, 'images', 'I1.info', 'metadata.json'));
    await symlink(path.join(outside, 'metadata.json'), path.join(folder, 'images', 'I1.info', 'metadata.json'));
    expect((await sut.readInfoFolders(folder))[0].metadata).toBeUndefined();
  });
});
