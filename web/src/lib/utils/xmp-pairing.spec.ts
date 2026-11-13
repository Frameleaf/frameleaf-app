import { pairXmpSidecars } from '$lib/utils/xmp-pairing';

const file = (name: string, folder = '') => {
  const asset = new File([], name);
  if (folder) Object.defineProperty(asset, 'webkitRelativePath', { value: `${folder}/${name}` });
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

  it('reports ambiguous same-stem files without uploading them as originals', () => {
    const raw = file('IMG.CR3');
    const jpeg = file('IMG.jpg');
    const sidecar = file('IMG.xmp');
    const result = pairXmpSidecars([raw, jpeg, sidecar], () => true);

    expect(result.pairs.size).toBe(0);
    expect([...result.unmatched]).toEqual([sidecar]);
  });
});
