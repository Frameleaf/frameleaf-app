import {
  PERSPECTIVE_MAX_SHRINK,
  applyHomography,
  isIdentityPerspective,
  perspectiveHomography,
  perspectiveTransform,
} from '$lib/frameleaf/perspective';

describe('perspective (keystone) on the editor stage', () => {
  it('matches the server definition: a positive vertical samples a narrower top edge', () => {
    const m = perspectiveHomography({ vertical: 100, horizontal: 0 });
    const [x, y] = applyHomography(m, 0, 0);
    expect(x).toBeCloseTo(PERSPECTIVE_MAX_SHRINK / 2, 9);
    expect(y).toBeCloseTo(0, 9);
    const [bx, by] = applyHomography(m, 1, 1);
    expect(bx).toBeCloseTo(1, 9);
    expect(by).toBeCloseTo(1, 9);
  });

  it('draws nothing for no correction', () => {
    expect(isIdentityPerspective({ vertical: 0, horizontal: 0 })).toBe(true);
    expect(perspectiveTransform({ vertical: 0, horizontal: 0 }, 400, 300)).toBe('');
    expect(perspectiveTransform(undefined, 400, 300)).toBe('');
  });

  it('transforms the picture by the inverse homography, centred on the frame', () => {
    const css = perspectiveTransform({ vertical: 100, horizontal: 0 }, 400, 300);
    const values = /^matrix3d\((.*)\)$/.exec(css)![1].split(', ').map(Number);
    expect(values).toHaveLength(16);
    // column-major: x' = (a x + b y + c) / (g x + h y + 1)
    const [a, d, g, b, e, h, c, f] = [0, 1, 3, 4, 5, 7, 12, 13].map((index) => values[index]);
    const project = (x: number, y: number) => {
      const w = g * x + h * y + 1;
      return [(a * x + b * y + c) / w, (d * x + e * y + f) / w];
    };
    // the source point sampled by the output's top-left corner is drawn at that corner
    const inset = (PERSPECTIVE_MAX_SHRINK / 2) * 400;
    const [x, y] = project(-200 + inset, -150);
    expect(x).toBeCloseTo(-200, 6);
    expect(y).toBeCloseTo(-150, 6);
    // the bottom corners stay put
    const [bx, by] = project(200, 150);
    expect(bx).toBeCloseTo(200, 6);
    expect(by).toBeCloseTo(150, 6);
  });
});
