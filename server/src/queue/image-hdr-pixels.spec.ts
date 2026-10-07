import { describe, expect, it } from 'vitest';
import type { PairedHdrImage } from 'src/queue/image-hdr.js';
import { resizeHdrImage } from 'src/queue/image-hdr-pixels.js';

const pixels = new Float32Array([2, 4, 8, 1, 6, 8, 12, 1, 10, 12, 16, 1, 14, 16, 20, 1]);
const image = (): PairedHdrImage => ({
  width: 2,
  height: 2,
  gamut: 1,
  referenceWhite: 203,
  data: Buffer.from(new Float32Array(pixels).buffer, pixels.byteOffset, pixels.byteLength),
  sdr: Buffer.from([60, 60, 60, 255, 60, 60, 60, 255, 60, 60, 60, 255, 60, 60, 60, 255]),
  sdrGamut: 0,
});

describe('HDR area resize', () => {
  it('resizes both surfaces together without clipping HDR or changing the authored SDR baseline', () => {
    const result = resizeHdrImage(image(), 1, 1024 ** 3);
    expect([result.width, result.height, result.gamut]).toEqual([1, 1, 1]);
    expect([...new Float32Array(result.data.buffer, result.data.byteOffset, 4)]).toEqual([8, 10, 14, 1]);
    expect('sdr' in result && Buffer.isBuffer(result.sdr) && [...result.sdr]).toEqual([60, 60, 60, 255]);
    expect('sdrGamut' in result && result.sdrGamut).toBe(0);
  });
  it('preserves alpha using premultiplied linear samples', () => {
    const source = image();
    delete (source as Partial<PairedHdrImage>).sdr;
    const pixels = new Float32Array(source.data.buffer, source.data.byteOffset, 16);
    pixels.set([100, 100, 100, 0], 0);
    const result = resizeHdrImage(source, 1, 1024 ** 3);
    expect([...new Float32Array(result.data.buffer, result.data.byteOffset, 4)]).toEqual([10, 12, 16, 0.75]);
  });
  it('rejects malformed surfaces and combined buffer budgets', () => {
    expect(() => resizeHdrImage(image(), 1, 20)).toThrow('budget');
    expect(() => resizeHdrImage({ ...image(), data: Buffer.alloc(4) }, 1, 1024 ** 3)).toThrow('surface');
    expect(() => resizeHdrImage(image(), NaN, 1024 ** 3)).toThrow('dimensions');
  });
  it('does not upscale or copy a full-resolution rendition', () => {
    const source = image();
    expect(resizeHdrImage(source, 8, 1024 ** 3)).toBe(source);
  });
});
