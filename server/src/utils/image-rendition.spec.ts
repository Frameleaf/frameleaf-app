import { describe, expect, it } from 'vitest';
import { imageRenditionIdentity } from 'src/utils/image-rendition.js';

const source = {
  sourceChecksum: Buffer.alloc(32, 1),
  editRevision: 0,
  rendererVersion: 'frameleaf-hdr-rendition/1',
  width: 64,
  height: 32,
  gamut: 1 as const,
  dynamicRange: 'hdr' as const,
};
describe('image rendition identity', () => {
  it('keys every input that changes rendered appearance', () => {
    const original = imageRenditionIdentity(source);
    expect(imageRenditionIdentity({ ...source })).toBe(original);
    for (const override of [
      { sourceChecksum: Buffer.alloc(32, 2) },
      { editRevision: 1 },
      { rendererVersion: 'frameleaf-hdr-rendition/2' },
      { width: 32 },
      { height: 16 },
      { gamut: 0 as const },
      { dynamicRange: 'sdr' as const },
    ])
      expect(imageRenditionIdentity({ ...source, ...override })).not.toBe(original);
  });
  it('refuses incomplete or non-finite source identity', () => {
    expect(() => imageRenditionIdentity({ ...source, width: NaN })).toThrow();
    expect(() => imageRenditionIdentity({ ...source, sourceChecksum: Buffer.alloc(0) })).toThrow();
  });
});
