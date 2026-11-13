import { pairXmpSidecars, rememberDroppedPath } from '$lib/utils/xmp-pairing';

const file = (name: string, folder = '') => {
  const asset = new File([], name);
  if (folder) {
    Object.defineProperty(asset, 'webkitRelativePath', { value: `${folder}/${name}` });
  }
  return asset;
};

describe('XMP upload pairing', () => {
  it('prefers full filenames and preserves folder boundaries', () => {
    const raw = file('IMG.CR3', 'photos');
    const rawOther = file('IMG.CR3', 'other');
    const exact = file('IMG.CR3.XMP', 'photos');
    const stem = file('img.xmp', 'other');
    const extra = file('IMG.xmp', 'photos');
    const result = pairXmpSidecars([extra, raw, rawOther, exact, stem], () => true);

    expect(result.pairs).toEqual(
      new Map([
        [raw, exact],
        [rawOther, stem],
      ]),
    );
    expect([...result.unmatched]).toEqual([extra]);
    expect(result.originals).toEqual([raw, rawOther]);
  });

  it('uses a dropped folder path when File.webkitRelativePath is empty', () => {
    const raw = file('IMG.CR3');
    const wrongFolder = file('IMG.xmp');
    const correctFolder = file('IMG.xmp');
    rememberDroppedPath(raw, '/trip/south/IMG.CR3');
    rememberDroppedPath(wrongFolder, '/trip/north/IMG.xmp');
    rememberDroppedPath(correctFolder, '/trip/south/IMG.xmp');

    const result = pairXmpSidecars([raw, wrongFolder, correctFolder], () => true);
    expect(result.pairs.get(raw)).toBe(correctFolder);
    expect([...result.unmatched]).toEqual([wrongFolder]);
  });

  it('reports ambiguous same-stem files without uploading them as originals', () => {
    const raw = file('IMG.CR3');
    const jpeg = file('IMG.jpg');
    const sidecar = file('IMG.xmp');
    const result = pairXmpSidecars([raw, jpeg, sidecar], () => true);

    expect(result.pairs.size).toBe(0);
    expect([...result.unmatched]).toEqual([sidecar]);
  });
});
