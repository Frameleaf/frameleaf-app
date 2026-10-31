import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { randomImage } from './images';
import type { SeededRandom } from './utils';

const capture = vi.hoisted(() => ({ svg: undefined as Buffer | undefined }));
vi.mock('sharp', async () => {
  const real = await vi.importActual<{ default: typeof sharp }>('sharp');
  return {
    default: (input: Buffer) => {
      capture.svg = input;
      return real.default(input);
    },
  };
});

it.each([
  [30, 20],
  [33, 25],
  [5, 5],
  [353, 235],
  [1500, 500],
])('preserves checkerboard pixels and seeded draws at %ix%i', async (width, height) => {
  const colors = [
    [26, 112, 198],
    [241, 85, 13],
  ];
  const nextInt = vi.fn();
  for (const value of [...colors.flat(), 3]) {
    nextInt.mockReturnValueOnce(value);
  }
  const jpeg = await randomImage({ nextInt } as unknown as SeededRandom, { width, height });
  expect(nextInt).toHaveBeenCalledTimes(7);
  expect(nextInt).toHaveBeenNthCalledWith(7, 0, 5);
  const real = await vi.importActual<{ default: typeof sharp }>('sharp');
  expect(await real.default(jpeg).metadata()).toMatchObject({ format: 'jpeg', width, height });
  const raster = await real.default(capture.svg).ensureAlpha().raw().toBuffer();
  const expected = Buffer.alloc(width * height * 4);
  for (let y = 0; y < Math.floor(height / 10) * 10; y++) {
    for (let x = 0; x < Math.floor(width / 10) * 10; x++) {
      const color = colors[(Math.floor(x / 10) + Math.floor(y / 10)) % 2];
      const offset = (y * width + x) * 4;
      expected.set([...color, 255], offset);
    }
  }
  expect(raster.equals(expected)).toBe(true);
});
