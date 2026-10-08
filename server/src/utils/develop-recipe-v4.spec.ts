import { BadRequestException } from '@nestjs/common';
import {
  type AssetDevelopMask,
  AssetDevelopMaskKind,
  KnownAssetDevelopRecipeSchema,
} from 'src/dtos/asset-develop.dto.js';
import { developFillMask, developFillWindow } from 'src/utils/develop-cleanup.js';
import {
  assertRenderableDevelopRecipe,
  renderDevelopProjection,
  renderHdrDevelopProjection,
} from 'src/utils/develop-envelope.js';
import {
  DEVELOP_RENDERER_VERSION,
  applyDevelopMasks,
  defaultDevelopRecipe,
  isIdentityDevelop,
  maskMappingFor,
  normalizeDevelopRecipe,
  planDevelopGeometry,
} from 'src/utils/develop-recipe.js';

/**
 * Renderer v4 (native API gaps): keystone `perspective`, Live and Motion Photo `keyFrame`, and the
 * server-generated Clean Up fill window and mask.
 */
describe('develop renderer v4', () => {
  it('names a new renderer identity', () => {
    expect(DEVELOP_RENDERER_VERSION).toBe('frameleaf-develop/4');
  });

  describe('recipe contract', () => {
    it('accepts perspective and keyFrame in a version 1 recipe and leaves them optional', () => {
      const parsed = KnownAssetDevelopRecipeSchema.parse({
        version: 1,
        perspective: { vertical: 40, horizontal: -12.5 },
        keyFrame: { timeMs: 1500 },
      });
      expect(parsed.perspective).toEqual({ vertical: 40, horizontal: -12.5 });
      expect(parsed.keyFrame).toEqual({ timeMs: 1500 });
      const plain = KnownAssetDevelopRecipeSchema.parse({ version: 1 });
      expect(plain).not.toHaveProperty('perspective');
      expect(plain).not.toHaveProperty('keyFrame');
      // a half-filled perspective defaults the other axis to zero
      expect(KnownAssetDevelopRecipeSchema.parse({ version: 1, perspective: { vertical: 5 } }).perspective).toEqual({
        vertical: 5,
        horizontal: 0,
      });
    });

    it.each([
      { perspective: { vertical: 101, horizontal: 0 } },
      { perspective: { vertical: 0, horizontal: -100.5 } },
      { keyFrame: { timeMs: -1 } },
      { keyFrame: { timeMs: 1.5 } },
      { keyFrame: { timeMs: 600_001 } },
    ])('refuses out-of-contract values %j', (value) => {
      expect(KnownAssetDevelopRecipeSchema.safeParse({ version: 1, ...value }).success).toBe(false);
    });

    it('renders both fields as known semantics (never as unsupported render fields)', () => {
      expect(
        renderDevelopProjection({ version: 1, perspective: { vertical: 10, horizontal: 0 }, keyFrame: { timeMs: 0 } }),
      ).toMatchObject({ perspective: { vertical: 10, horizontal: 0 }, keyFrame: { timeMs: 0 } });
    });

    it('lets an HDR revision use perspective but refuses a key frame', () => {
      const hdr = { version: 6, renderer: 'frameleaf-develop-hdr/4' };
      expect(renderHdrDevelopProjection({ ...hdr, perspective: { vertical: 20, horizontal: 0 } })).toMatchObject({
        perspective: { vertical: 20, horizontal: 0 },
      });
      expect(() => assertRenderableDevelopRecipe({ ...hdr, keyFrame: { timeMs: 100 } })).toThrow(
        expect.objectContaining({
          response: expect.objectContaining({ code: 'develop_key_frame_unsupported' }),
        }) as BadRequestException,
      );
    });
  });

  describe('normalization and identity', () => {
    it('keeps a correcting perspective and a key frame, drops a zero perspective', () => {
      const recipe = normalizeDevelopRecipe({
        ...defaultDevelopRecipe(),
        perspective: { vertical: 33.33333, horizontal: 0 },
        keyFrame: { timeMs: 1234.4 },
      });
      expect(recipe.perspective).toEqual({ vertical: 33.3333, horizontal: 0 });
      expect(recipe.keyFrame).toEqual({ timeMs: 1234 });
      expect(normalizeDevelopRecipe({ perspective: { vertical: 0, horizontal: 0 } })).not.toHaveProperty('perspective');
    });

    it('a perspective or a key frame is an edit', () => {
      expect(isIdentityDevelop(defaultDevelopRecipe())).toBe(true);
      expect(isIdentityDevelop({ ...defaultDevelopRecipe(), perspective: { vertical: 1, horizontal: 0 } })).toBe(false);
      expect(isIdentityDevelop({ ...defaultDevelopRecipe(), keyFrame: { timeMs: 0 } })).toBe(false);
    });
  });

  describe('geometry plan and mask mapping', () => {
    it('carries the perspective into the plan and the mask mapping only when it corrects', () => {
      const plain = planDevelopGeometry(defaultDevelopRecipe(), 400, 300);
      expect(plain).not.toHaveProperty('perspective');
      expect(maskMappingFor(plain)).not.toHaveProperty('perspective');
      const plan = planDevelopGeometry(
        { ...defaultDevelopRecipe(), perspective: { vertical: -20, horizontal: 10 } },
        400,
        300,
      );
      expect(plan.perspective).toEqual({ vertical: -20, horizontal: 10 });
      expect(plan.output).toEqual({ width: 400, height: 300 });
      expect(maskMappingFor(plan).perspective).toEqual({ vertical: -20, horizontal: 10 });
    });

    it('keeps a mask on the content it was drawn over through the keystone warp', () => {
      // a linear mask over the left half of the oriented frame; with the top widened the output's
      // top-left corner samples further in, so the mask's weight there falls
      const mask: AssetDevelopMask = {
        id: 'm',
        name: null,
        kind: AssetDevelopMaskKind.Linear,
        enabled: true,
        invert: false,
        x: 0,
        y: 0.5,
        endX: 0.3,
        endY: 0.5,
        radiusX: 0.25,
        radiusY: 0.25,
        feather: 50,
        amount: 100,
        adjustments: {
          exposure: 2,
          contrast: 0,
          highlights: 0,
          shadows: 0,
          whites: 0,
          blacks: 0,
          temperature: 0,
          tint: 0,
          vibrance: 0,
          saturation: 0,
          dehaze: 0,
        },
      };
      const width = 40;
      const height = 40;
      const render = (recipe: ReturnType<typeof defaultDevelopRecipe>) => {
        const data = new Uint8Array(width * height * 3).fill(64);
        applyDevelopMasks(
          data,
          { width, height, channels: 3 },
          [mask],
          maskMappingFor(planDevelopGeometry(recipe, width, height)),
        );
        return data;
      };
      const flat = render(defaultDevelopRecipe());
      const keystone = render({ ...defaultDevelopRecipe(), perspective: { vertical: 100, horizontal: 0 } });
      const topLeft = (data: Uint8Array) => data[(1 * width + 1) * 3];
      const bottomLeft = (data: Uint8Array) => data[((height - 2) * width + 1) * 3];
      expect(topLeft(keystone)).toBeLessThan(topLeft(flat));
      expect(Math.abs(bottomLeft(keystone) - bottomLeft(flat))).toBeLessThanOrEqual(2);
    });
  });

  describe('server-generated fills', () => {
    it('frames the area with context, bounded to the original and to the longest side', () => {
      const fill = developFillWindow(
        { left: 1000, top: 1000, right: 1400, bottom: 1200 },
        { width: 4000, height: 3000 },
      );
      expect(fill.window).toEqual({ left: 800, top: 800, right: 1600, bottom: 1400 });
      expect(fill.scale).toBe(1);
      expect(fill.area).toEqual({ left: 200, top: 200, width: 400, height: 200 });

      const big = developFillWindow(
        { left: 0, top: 0, right: 4000, bottom: 3000 },
        { width: 4000, height: 3000 },
        1000,
      );
      expect(big.window).toEqual({ left: 0, top: 0, right: 4000, bottom: 3000 });
      expect(big.scale).toBe(0.25);
      expect([big.width, big.height]).toEqual([1000, 750]);
      expect(big.area).toEqual({ left: 0, top: 0, width: 1000, height: 750 });
    });

    it('masks exactly the area footprint (region and strokes)', () => {
      const original = { width: 100, height: 100 };
      const region = { region: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, feather: 50 };
      const fill = developFillWindow({ left: 40, top: 40, right: 60, bottom: 60 }, original);
      const mask = developFillMask(region, original, fill);
      expect(mask).toHaveLength(fill.width * fill.height);
      const at = (x: number, y: number) => mask[(y - fill.window.top) * fill.width + (x - fill.window.left)];
      expect(at(50, 50)).toBe(255);
      expect(at(35, 35)).toBe(0);

      const strokes = {
        strokes: [{ points: [[0.5, 0.5]] as [number, number][], radius: 0.05, erase: false }],
        feather: 0,
      };
      const strokeMask = developFillMask(strokes, original, fill);
      expect(strokeMask[(50 - fill.window.top) * fill.width + (50 - fill.window.left)]).toBe(255);
      expect(strokeMask[(31 - fill.window.top) * fill.width + (31 - fill.window.left)]).toBe(0);
    });
  });
});
