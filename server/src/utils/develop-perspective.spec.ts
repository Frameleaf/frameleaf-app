import {
  PERSPECTIVE_MAX_SHRINK,
  applyHomography,
  isIdentityPerspective,
  perspectiveFor,
  perspectiveHomography,
  perspectiveSourcePoint,
  squareToQuad,
  warpPerspective,
} from 'src/utils/develop-perspective.js';

const close = (actual: number[], expected: number[]) => {
  for (const [index, value] of actual.entries()) {
    expect(value).toBeCloseTo(expected[index], 9);
  }
};

describe('develop perspective (keystone)', () => {
  it('is no correction when omitted or zero', () => {
    expect(isIdentityPerspective(undefined)).toBe(true);
    expect(isIdentityPerspective({ vertical: 0, horizontal: 0 })).toBe(true);
    expect(perspectiveFor({ vertical: 0, horizontal: 0 })).toBeNull();
    expect(perspectiveSourcePoint(null, 3, 4, 10, 10)).toEqual([3, 4]);
    close(applyHomography(perspectiveHomography({}), 0.25, 0.75), [0.25, 0.75]);
  });

  it('maps the unit square onto any quad (Heckbert)', () => {
    const m = squareToQuad([0.1, 0.2], [0.9, 0.1], [1, 1], [0, 0.8]);
    close(applyHomography(m, 0, 0), [0.1, 0.2]);
    close(applyHomography(m, 1, 0), [0.9, 0.1]);
    close(applyHomography(m, 1, 1), [1, 1]);
    close(applyHomography(m, 0, 1), [0, 0.8]);
  });

  it('positive vertical samples a narrower top edge, so the top of the picture widens', () => {
    const m = perspectiveHomography({ vertical: 100, horizontal: 0 });
    const inset = PERSPECTIVE_MAX_SHRINK / 2;
    close(applyHomography(m, 0, 0), [inset, 0]);
    close(applyHomography(m, 1, 0), [1 - inset, 0]);
    close(applyHomography(m, 0, 1), [0, 1]);
    close(applyHomography(m, 1, 1), [1, 1]);
    // straight lines stay straight: the vertical centre line is unchanged
    close(applyHomography(m, 0.5, 0.3), [0.5, applyHomography(m, 0.5, 0.3)[1]]);
  });

  it('negative horizontal samples a shorter left edge', () => {
    const m = perspectiveHomography({ vertical: 0, horizontal: -50 });
    const inset = (PERSPECTIVE_MAX_SHRINK * 0.5) / 2;
    close(applyHomography(m, 0, 0), [0, inset]);
    close(applyHomography(m, 0, 1), [0, 1 - inset]);
    close(applyHomography(m, 1, 0), [1, 0]);
  });

  it('every sample stays inside the frame, so the corrected frame is covered', () => {
    const m = perspectiveHomography({ vertical: -100, horizontal: 100 });
    for (const x of [0, 0.3, 1]) {
      for (const y of [0, 0.6, 1]) {
        const [u, v] = applyHomography(m, x, y);
        expect(u).toBeGreaterThanOrEqual(-1e-9);
        expect(u).toBeLessThanOrEqual(1 + 1e-9);
        expect(v).toBeGreaterThanOrEqual(-1e-9);
        expect(v).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('warps 8-bit and float pixels into new buffers of the same size', () => {
    const width = 8;
    const height = 8;
    const data = new Uint8Array(width * height);
    // a vertical bar in column 0: after widening the top, the top rows sample further in
    for (let y = 0; y < height; y++) data[y * width] = 255;
    const m = perspectiveHomography({ vertical: 100, horizontal: 0 })!;
    const out = warpPerspective(data, { width, height, channels: 1 }, m);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out).toHaveLength(data.length);
    // the top-left now samples well inside the frame; the bottom-left barely moves off the bar
    expect(out[0]).toBeLessThan(64);
    expect(out[(height - 1) * width]).toBeGreaterThan(200);
    const floats = warpPerspective(new Float32Array(data), { width, height, channels: 1 }, m);
    expect(floats).toBeInstanceOf(Float32Array);
  });
});
