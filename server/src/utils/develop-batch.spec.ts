import { batchExportName, matchBatchReturns } from 'src/utils/develop-batch.js';

const first = {
  id: '11111111-1111-4111-8111-111111111111',
  exportId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  fileName: 'Photo.JPG',
  exportName: 'Photo__fl_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.JPG',
};
const second = {
  id: '22222222-2222-4222-8222-222222222222',
  exportId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  fileName: 'photo.raw',
  exportName: 'photo__fl_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.raw',
};
const file = (fileName: string, itemId?: string) => ({ fileName, checksum: 'a'.repeat(64), ...(itemId && { itemId }) });

describe('batch return matching', () => {
  it('exports path-safe names with stable identities even for duplicate and case-colliding names', () => {
    expect(batchExportName('../nested/Photo.JPG', first.exportId)).toBe(first.exportName);
    expect(batchExportName(String.raw`..\nested\Photo.JPG`, first.exportId)).toBe(first.exportName);
    expect(batchExportName('photo.jpg', second.exportId)).not.toBe(first.exportName.toLowerCase());
    expect(batchExportName('x'.repeat(400) + '.jpg', first.exportId).length).toBeLessThanOrEqual(255);
  });
  it('prefers stable identity and refuses ambiguous stems and foreign ids', () => {
    const result = matchBatchReturns(
      [first, second],
      [
        file(first.exportName.replace('.JPG', '-edit.tif')),
        file('PHOTO.tif'),
        file('renamed.jpg'),
        file('renamed.jpg', second.id),
        file('renamed.jpg', 'foreign'),
      ],
    );
    expect(result.map((row) => row.status)).toEqual(['matched', 'ambiguous', 'unmatched', 'matched', 'unmatched']);
    expect(result[0].itemId).toBe(first.id);
    expect(result[3].itemId).toBe(second.id);
  });
  it('never silently maps two files to one batch item and skips sidecars/manifests', () => {
    expect(matchBatchReturns([first], [file('Photo.png'), file('Photo.tif')]).map((row) => row.status)).toEqual([
      'ambiguous',
      'ambiguous',
    ]);
    expect(matchBatchReturns([first], [file('manifest.json'), file('Photo.xmp')]).map((row) => row.status)).toEqual([
      'skipped',
      'skipped',
    ]);
  });
  it('matches a large selection with bounded filename normalization', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({
      id: `item-${i}`,
      exportId: `export-${i}`,
      fileName: `photo-${i}.jpg`,
      exportName: `photo-${i}-export.jpg`,
    }));
    const normalize = vi.spyOn(String.prototype, 'normalize');
    try {
      const result = matchBatchReturns(
        items,
        items.map((item) => file(item.fileName)),
      );
      expect(result.every((row) => row.status === 'matched')).toBe(true);
      expect(normalize.mock.calls.length).toBeLessThanOrEqual(items.length * 3);
    } finally {
      normalize.mockRestore();
    }
  });
});
