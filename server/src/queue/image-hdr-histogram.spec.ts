import { hdrHistogram } from 'src/queue/image-hdr-histogram.js';

it('bins linear headroom in stops and excludes transparent pixels', () => {
  const data = new Float32Array([0, 0, 0, 1, 1, 1, 1, 1, 8, 8, 8, 1, 32, 32, 32, 0]);
  const result = hdrHistogram({
    data: Buffer.from(data.buffer, data.byteOffset, data.byteLength),
    width: 4,
    height: 1,
    gamut: 0,
    referenceWhite: 203,
  });
  expect(result.samples).toBe(3);
  expect(result.peakStops).toBe(3);
  expect(result.red[40]).toBe(1); // reference white: 0 EV
  expect(result.red[52]).toBe(1); // +3 EV
  expect(result.clipped).toEqual({ shadows: 1 / 3, highlights: 0 });
});
