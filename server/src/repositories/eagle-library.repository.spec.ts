import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EagleLibraryRepository } from 'src/repositories/eagle-library.repository.js';

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

  it('lists .library folders a few levels down, without following links or opening hidden folders', async () => {
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

  it('reads the item folders and their file names, never a linked file', async () => {
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
    await expect(sut.statFile(sut.itemFilePath(folder, 'I1', 'a.jpg'))).resolves.toMatchObject({ size: 5 });
    await expect(sut.statFile(path.join(folder, 'images', 'I2.info', 'b.jpg'))).resolves.toBeUndefined();
  });
});
