import { StorageCore } from 'src/cores/storage.core.js';
import { LibraryImportPathReason } from 'src/enum.js';
import {
  checkImportPathFormat,
  checkImportPaths,
  invalidExclusionPatterns,
  isSameOrInside,
  normalizeImportPath,
} from 'src/utils/library-paths.js';

const readable = {
  stat: () => Promise.resolve({ isDirectory: () => true }),
  checkFileExists: () => Promise.resolve(true),
};

describe('library import folders (FL-78)', () => {
  beforeEach(() => {
    StorageCore.reset();
    StorageCore.setMediaLocation('/data');
  });

  it('normalizes trailing and doubled slashes', () => {
    expect(normalizeImportPath('/mnt//photos/')).toBe('/mnt/photos');
    expect(normalizeImportPath('/')).toBe('/');
  });

  it('compares folders, not string prefixes', () => {
    expect(isSameOrInside('/mnt/photos/2024', '/mnt/photos')).toBe(true);
    expect(isSameOrInside('/mnt/photos-old', '/mnt/photos')).toBe(false);
  });

  it.each([
    ['relative/path', LibraryImportPathReason.NotAbsolute],
    ['/mnt/../etc', LibraryImportPathReason.ParentTraversal],
    ['/mnt/pho\u{7}tos', LibraryImportPathReason.InvalidCharacters],
    ['/data/library', LibraryImportPathReason.UploadFolder],
    ['/', LibraryImportPathReason.ContainsUploadFolder],
  ])('refuses %s', (importPath, reason) => {
    expect(checkImportPathFormat(importPath)?.reason).toBe(reason);
  });

  it('refuses nested folders of the same library', async () => {
    const [outer, inner] = await checkImportPaths(readable, ['/mnt/photos', '/mnt/photos/2024']);
    expect(outer.reason).toBe(LibraryImportPathReason.Nested);
    expect(inner.reason).toBe(LibraryImportPathReason.Nested);
  });

  it("refuses a folder containing another library's folder", async () => {
    const [check] = await checkImportPaths(readable, ['/mnt'], {
      neighbours: [{ id: 'other', name: 'Other', importPaths: ['/mnt/photos'] }],
    });
    expect(check).toEqual(expect.objectContaining({ isValid: false, reason: LibraryImportPathReason.OtherLibrary }));
  });

  it('accepts a readable folder of its own', async () => {
    const [check] = await checkImportPaths(readable, ['/mnt/photos'], {
      neighbours: [{ id: 'other', name: 'Other', importPaths: ['/mnt/photos-old'] }],
    });
    expect(check).toEqual({ importPath: '/mnt/photos', isValid: true, reason: LibraryImportPathReason.Valid });
  });

  it('finds unusable exclusion patterns', () => {
    expect(invalidExclusionPatterns(['**/.DS_Store', 'bad\u{0}'])).toEqual(['bad\u{0}']);
  });
});
