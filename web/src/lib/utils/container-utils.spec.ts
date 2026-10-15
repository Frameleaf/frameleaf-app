import {
  type ContentMetrics,
  getNaturalSize,
  mapNormalizedRectToContent,
  mapNormalizedToContent,
  type Size,
  scaleToCover,
  scaleToFit,
} from '$lib/utils/container-utils';

const mockImage = (props: {
  naturalWidth: number;
  naturalHeight: number;
  width: number;
  height: number;
}): HTMLImageElement => props as unknown as HTMLImageElement;

const mockVideo = (props: {
  videoWidth: number;
  videoHeight: number;
  clientWidth: number;
  clientHeight: number;
}): HTMLVideoElement => {
  const element = Object.create(HTMLVideoElement.prototype);
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(element, key, { value, writable: true, configurable: true });
  }
  return element;
};

describe('scaleToFit', () => {
  it('should return full width when image is wider than container', () => {
    expect(scaleToFit({ width: 2000, height: 1000 }, { width: 800, height: 600 })).toEqual({ width: 800, height: 400 });
  });

  it('should return full height when image is taller than container', () => {
    expect(scaleToFit({ width: 1000, height: 2000 }, { width: 800, height: 600 })).toEqual({ width: 300, height: 600 });
  });

  it('should return exact fit when aspect ratios match', () => {
    expect(scaleToFit({ width: 1600, height: 900 }, { width: 800, height: 450 })).toEqual({ width: 800, height: 450 });
  });

  it('should handle square images in landscape container', () => {
    expect(scaleToFit({ width: 500, height: 500 }, { width: 800, height: 600 })).toEqual({ width: 600, height: 600 });
  });

  it('should handle square images in portrait container', () => {
    expect(scaleToFit({ width: 500, height: 500 }, { width: 400, height: 600 })).toEqual({ width: 400, height: 400 });
  });
});

describe('getNaturalSize', () => {
  it('should return naturalWidth/naturalHeight for images', () => {
    const img = mockImage({ naturalWidth: 4000, naturalHeight: 3000, width: 800, height: 600 });
    expect(getNaturalSize(img)).toEqual({ width: 4000, height: 3000 });
  });

  it('should return videoWidth/videoHeight for videos', () => {
    const video = mockVideo({ videoWidth: 1920, videoHeight: 1080, clientWidth: 800, clientHeight: 600 });
    expect(getNaturalSize(video)).toEqual({ width: 1920, height: 1080 });
  });
});

describe('scaleToCover', () => {
  it('should scale up to cover container when image is smaller', () => {
    expect(scaleToCover({ width: 400, height: 300 }, { width: 800, height: 600 })).toEqual({
      width: 800,
      height: 600,
    });
  });

  it('should use height scale when image is wider than container', () => {
    expect(scaleToCover({ width: 2000, height: 1000 }, { width: 800, height: 600 })).toEqual({
      width: 1200,
      height: 600,
    });
  });

  it('should use width scale when image is taller than container', () => {
    expect(scaleToCover({ width: 1000, height: 2000 }, { width: 800, height: 600 })).toEqual({
      width: 800,
      height: 1600,
    });
  });
});

describe('mapNormalizedToContent', () => {
  const metrics = { contentWidth: 800, contentHeight: 400, offsetX: 0, offsetY: 100 };

  it('should map top-left corner', () => {
    expect(mapNormalizedToContent({ x: 0, y: 0 }, metrics)).toEqual({ x: 0, y: 100 });
  });

  it('should map bottom-right corner', () => {
    expect(mapNormalizedToContent({ x: 1, y: 1 }, metrics)).toEqual({ x: 800, y: 500 });
  });

  it('should map center point', () => {
    expect(mapNormalizedToContent({ x: 0.5, y: 0.5 }, metrics)).toEqual({ x: 400, y: 300 });
  });

  it('should apply offsets correctly for letterboxed content', () => {
    const letterboxed = { contentWidth: 300, contentHeight: 600, offsetX: 250, offsetY: 0 };
    expect(mapNormalizedToContent({ x: 0, y: 0 }, letterboxed)).toEqual({ x: 250, y: 0 });
    expect(mapNormalizedToContent({ x: 1, y: 1 }, letterboxed)).toEqual({ x: 550, y: 600 });
  });

  it('should accept Size (zero offsets)', () => {
    const size = { width: 800, height: 400 };
    expect(mapNormalizedToContent({ x: 0, y: 0 }, size)).toEqual({ x: 0, y: 0 });
    expect(mapNormalizedToContent({ x: 1, y: 1 }, size)).toEqual({ x: 800, y: 400 });
    expect(mapNormalizedToContent({ x: 0.5, y: 0.5 }, size)).toEqual({ x: 400, y: 200 });
  });
});

describe('mapNormalizedRectToContent', () => {
  const metrics = { contentWidth: 800, contentHeight: 400, offsetX: 0, offsetY: 100 };

  it('should map a normalized rect to content pixel coordinates', () => {
    const rect = mapNormalizedRectToContent({ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }, metrics);
    expect(rect).toEqual({ left: 200, top: 200, width: 400, height: 200 });
  });

  it('should map full image rect', () => {
    const rect = mapNormalizedRectToContent({ x: 0, y: 0 }, { x: 1, y: 1 }, metrics);
    expect(rect).toEqual({ left: 0, top: 100, width: 800, height: 400 });
  });

  it('should handle letterboxed content with horizontal offsets', () => {
    const letterboxed = { contentWidth: 300, contentHeight: 600, offsetX: 250, offsetY: 0 };
    const rect = mapNormalizedRectToContent({ x: 0, y: 0 }, { x: 1, y: 1 }, letterboxed);
    expect(rect).toEqual({ left: 250, top: 0, width: 300, height: 600 });
  });

  it('should accept Size (zero offsets)', () => {
    const size = { width: 800, height: 400 };
    const rect = mapNormalizedRectToContent({ x: 0.25, y: 0.25 }, { x: 0.75, y: 0.75 }, size);
    expect(rect).toEqual({ left: 200, top: 100, width: 400, height: 200 });
  });
});

describe('coordinate invariants', () => {
  it('preserves endpoint rounding before subtracting offsets', () => {
    const metrics = { contentWidth: 1, contentHeight: 1, offsetX: 2 ** 53, offsetY: -(2 ** 53) };
    expect(mapNormalizedRectToContent({ x: 0, y: 0 }, { x: 1, y: 1 }, metrics)).toEqual({
      left: 2 ** 53,
      top: -(2 ** 53),
      width: 0,
      height: 1,
    });
  });

  it('preserves signed zero, non-finite values, reversed points and inherited metrics without mutation', () => {
    const values = [-0, 0, -1, 1, Number.MIN_VALUE, Number.MAX_VALUE, NaN, Infinity, -Infinity];
    const inherited: ContentMetrics = Object.freeze(
      Object.create({
        contentWidth: 800,
        contentHeight: 600,
        offsetX: 250,
        offsetY: 100,
      }),
    );
    const sizes: (Size | ContentMetrics)[] = [
      Object.freeze({ width: 800, height: 600 }),
      Object.freeze({ width: -0, height: -0 }),
      Object.freeze({ contentWidth: Infinity, contentHeight: 0, offsetX: -Infinity, offsetY: -0 }),
      inherited,
    ];
    for (const size of sizes) {
      for (const x of values) {
        for (const y of values) {
          const topLeft = Object.freeze({ x, y });
          const bottomRight = Object.freeze({ x: y, y: x });
          const tl = mapNormalizedToContent(topLeft, size);
          const br = mapNormalizedToContent(bottomRight, size);
          const result = mapNormalizedRectToContent(topLeft, bottomRight, size);
          expect(result.top).toBe(tl.y);
          expect(result.left).toBe(tl.x);
          expect(result.width).toBe(br.x - tl.x);
          expect(result.height).toBe(br.y - tl.y);
        }
      }
    }
  });

  it('matches independent point mapping across seeded finite rectangles', () => {
    let seed = 0x5e_43_06_39;
    const random = () => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let i = 0; i < 256; i++) {
      const topLeft = Object.freeze({ x: random() * 4 - 2, y: random() * 4 - 2 });
      const bottomRight = Object.freeze({ x: random() * 4 - 2, y: random() * 4 - 2 });
      const size = Object.freeze({ width: random() * 8000, height: random() * 8000 });
      const metrics = Object.freeze({
        contentWidth: size.width,
        contentHeight: size.height,
        offsetX: random() * 4000,
        offsetY: random() * 4000,
      });
      for (const dimensions of [size, metrics]) {
        const tl = mapNormalizedToContent(topLeft, dimensions);
        const br = mapNormalizedToContent(bottomRight, dimensions);
        expect(mapNormalizedRectToContent(topLeft, bottomRight, dimensions)).toEqual({
          top: tl.y,
          left: tl.x,
          width: br.x - tl.x,
          height: br.y - tl.y,
        });
      }
    }
  });

  it('reads new image and video dimensions after a resize or source change', () => {
    const image = mockImage({ naturalWidth: 2000, naturalHeight: 1000, width: 800, height: 600 });
    const video = mockVideo({ videoWidth: 2000, videoHeight: 1000, clientWidth: 800, clientHeight: 600 });
    expect(getNaturalSize(image)).toEqual(getNaturalSize(video));
    Object.assign(image, { naturalWidth: 1000, naturalHeight: 2000, width: 400, height: 300 });
    Object.assign(video, { videoWidth: 1000, videoHeight: 2000, clientWidth: 400, clientHeight: 300 });
    expect(getNaturalSize(image)).toEqual({ width: 1000, height: 2000 });
    expect(getNaturalSize(video)).toEqual(getNaturalSize(image));
    expect(scaleToFit(getNaturalSize(image), { width: 400, height: 300 })).toEqual({ width: 150, height: 300 });
    expect(scaleToFit(getNaturalSize(video), { width: 400, height: 300 })).toEqual({ width: 150, height: 300 });
  });
});
