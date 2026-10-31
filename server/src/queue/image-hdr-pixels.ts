// Standalone image worker has no application alias loader.
// eslint-disable-next-line no-restricted-imports
import { SharpResourceLimitError } from './sharp-protocol.js';
import type { LinearHdrImage, PairedHdrImage } from 'src/queue/image-hdr.js';

/** Area filtering in linear light; the authored SDR and reconstructed HDR share the same footprint. */
export function resizeHdrImage(image: LinearHdrImage | PairedHdrImage, size: number, maxBytes: number) {
  const { width, height, data } = image;
  if ([width, height, size].some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new SharpResourceLimitError('invalid HDR dimensions');
  }
  const paired = 'sdr' in image;
  if (
    data.length !== width * height * 16 ||
    data.byteOffset % 4 !== 0 ||
    (paired && image.sdr.length !== width * height * 4)
  ) {
    throw new SharpResourceLimitError('invalid HDR surface');
  }
  const scale = Math.min(1, size / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)),
    h = Math.max(1, Math.round(height * scale));
  if (data.length + (paired ? image.sdr.length : 0) + w * h * (paired ? 20 : 16) > maxBytes) {
    throw new SharpResourceLimitError('HDR resize exceeds the combined surface budget');
  }
  if (scale === 1) return image;
  const input = new Float32Array(data.buffer, data.byteOffset, data.length / 4);
  const output = new Float32Array(w * h * 4);
  const sdr = paired ? Buffer.alloc(w * h * 4) : undefined;
  const linear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const srgb = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const left = (x * width) / w,
        right = ((x + 1) * width) / w;
      const top = (y * height) / h,
        bottom = ((y + 1) * height) / h;
      const area = (right - left) * (bottom - top);
      let alpha = 0,
        r = 0,
        g = 0,
        b = 0,
        sa = 0,
        sr = 0,
        sg = 0,
        sb = 0;
      for (let sy = Math.floor(top); sy < Math.ceil(bottom); sy++)
        for (let sx = Math.floor(left); sx < Math.ceil(right); sx++) {
          const weight =
            (Math.min(right, sx + 1) - Math.max(left, sx)) * (Math.min(bottom, sy + 1) - Math.max(top, sy));
          const i = (sy * width + sx) * 4,
            a = input[i + 3];
          if (
            !Number.isFinite(a) ||
            a < 0 ||
            a > 1 ||
            [input[i], input[i + 1], input[i + 2]].some((value) => !Number.isFinite(value))
          ) {
            throw new Error('INVALID_LINEAR_PIXELS');
          }
          alpha += a * weight;
          r += input[i] * a * weight;
          g += input[i + 1] * a * weight;
          b += input[i + 2] * a * weight;
          if (paired) {
            const a = image.sdr[i + 3] / 255;
            sa += a * weight;
            sr += linear(image.sdr[i] / 255) * a * weight;
            sg += linear(image.sdr[i + 1] / 255) * a * weight;
            sb += linear(image.sdr[i + 2] / 255) * a * weight;
          }
        }
      const i = (y * w + x) * 4;
      output.set(alpha ? [r / alpha, g / alpha, b / alpha, alpha / area] : [0, 0, 0, 0], i);
      if (sdr)
        sdr.set(
          sa
            ? [
                Math.round(srgb(sr / sa) * 255),
                Math.round(srgb(sg / sa) * 255),
                Math.round(srgb(sb / sa) * 255),
                Math.round((sa / area) * 255),
              ]
            : [0, 0, 0, 0],
          i,
        );
    }
  const resized = {
    ...image,
    width: w,
    height: h,
    data: Buffer.from(output.buffer, output.byteOffset, output.byteLength),
  };
  return sdr && paired ? { ...resized, sdr, sdrGamut: image.sdrGamut } : resized;
}
