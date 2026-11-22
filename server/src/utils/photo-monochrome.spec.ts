import { describe, expect, it } from 'vitest';
import { isMonochromeImage } from 'src/utils/photo-monochrome.js';

const image = (count: number, pixel: (index: number) => [number, number, number]) => {
  const data = new Uint8Array(count * 3);
  for (let index = 0; index < count; index++) {
    data.set(pixel(index), index * 3);
  }
  return data;
};

/** A sepia ramp: one warm hue from shadow to highlight. */
const sepia = (index: number): [number, number, number] => {
  const level = 40 + (index % 180);
  return [level, Math.round(level * 0.82), Math.round(level * 0.62)];
};

describe('isMonochromeImage', () => {
  it('takes a grey photo', () => {
    expect(
      isMonochromeImage(
        image(1000, (index) => [index % 256, index % 256, index % 256]),
        3,
      ),
    ).toBe(true);
  });

  it('takes a grey photo with JPEG colour noise', () => {
    expect(
      isMonochromeImage(
        image(1000, (index) => [120 + (index % 5), 120, 122 - (index % 4)]),
        3,
      ),
    ).toBe(true);
  });

  it('counts sepia as black and white', () => {
    expect(isMonochromeImage(image(1000, sepia), 3)).toBe(true);
  });

  it('keeps a grey photo with a small coloured date stamp', () => {
    expect(
      isMonochromeImage(
        image(1000, (index) => (index < 10 ? [255, 120, 0] : [90, 90, 90])),
        3,
      ),
    ).toBe(true);
  });

  it('refuses a photo of many colours', () => {
    const colours: [number, number, number][] = [
      [200, 40, 40],
      [40, 180, 60],
      [40, 70, 210],
      [220, 200, 40],
    ];
    expect(
      isMonochromeImage(
        image(1000, (index) => colours[index % 4]),
        3,
      ),
    ).toBe(false);
  });

  it('refuses a saturated picture of one hue', () => {
    expect(
      isMonochromeImage(
        image(1000, (index) => [230, 90 + (index % 20), 20]),
        3,
      ),
    ).toBe(false);
  });

  it('reads past an alpha channel', () => {
    const data = new Uint8Array(400);
    for (let index = 0; index < 100; index++) {
      data.set([200, 40, 40 + (index % 2) * 160, 255], index * 4);
    }
    expect(isMonochromeImage(data, 4)).toBe(false);
  });

  it('treats a one-channel image as black and white, and no pixels as not', () => {
    expect(isMonochromeImage(new Uint8Array([1, 2, 3]), 1)).toBe(true);
    expect(isMonochromeImage(new Uint8Array(), 3)).toBe(false);
  });
});
