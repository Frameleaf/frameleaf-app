// Standalone image worker has no application alias loader.
// eslint-disable-next-line no-restricted-imports
import type { LinearHdrImage } from './image-hdr.js';

/** Stops are relative to reference white, before tone mapping or encoding. */
export function hdrHistogram(image: LinearHdrImage) {
  const minStops = -10;
  const maxStops = 6;
  const bins = 64;
  const red = Array.from({ length: bins }, () => 0);
  const green = Array.from({ length: bins }, () => 0);
  const blue = Array.from({ length: bins }, () => 0);
  const luma = Array.from({ length: bins }, () => 0);
  const weights =
    image.gamut === 2
      ? [0.2627, 0.678, 0.0593]
      : image.gamut === 1
        ? [0.2289746, 0.6917385, 0.0792869]
        : [0.2126, 0.7152, 0.0722];
  const pixels = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.byteLength / 4);
  const index = (value: number) =>
    Math.max(
      0,
      Math.min(
        bins - 1,
        Math.floor(((Math.log2(Math.max(2 ** minStops, value)) - minStops) / (maxStops - minStops)) * bins),
      ),
    );
  let samples = 0;
  let shadows = 0;
  let highlights = 0;
  let peak = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] === 0) continue;
    const r = pixels[i],
      g = pixels[i + 1],
      b = pixels[i + 2];
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) throw new Error('INVALID_HDR_PIXELS');
    red[index(r)]++;
    green[index(g)]++;
    blue[index(b)]++;
    const luminance = r * weights[0] + g * weights[1] + b * weights[2];
    luma[index(luminance)]++;
    if (luminance <= 0) shadows++;
    if (Math.max(r, g, b) >= 10_000 / image.referenceWhite) highlights++;
    peak = Math.max(peak, r, g, b);
    samples++;
  }
  return {
    version: 1 as const,
    bins,
    minStops,
    maxStops,
    referenceWhite: image.referenceWhite,
    peakStops: peak > 0 ? Math.max(minStops, Math.log2(peak)) : minStops,
    red,
    green,
    blue,
    luma,
    max: Math.max(1, ...red, ...green, ...blue, ...luma),
    samples,
    clipped: { shadows: shadows / Math.max(1, samples), highlights: highlights / Math.max(1, samples) },
  };
}
export type HdrHistogram = ReturnType<typeof hdrHistogram>;
