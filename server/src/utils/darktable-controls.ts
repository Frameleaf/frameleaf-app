import type { DarktableDevelopRecipe } from 'src/dtos/asset-develop.dto.js';

// All layouts/defaults are from darktable 03179f8e080aa9cedebfe14b098b7ba88940a292.
// References and native qualification commands: test/native/README-darktable.md.
export type NativeModule = { version: number; params: Buffer; colorspace: number; enabled: boolean };
const floats = (values: number[]) => {
  const buffer = Buffer.alloc(values.length * 4);
  for (const [index, value] of values.entries()) buffer.writeFloatLE(value, index * 4);
  return buffer;
};

export function nativeModuleParams(
  recipe: Pick<
    DarktableDevelopRecipe,
    | 'shadows'
    | 'highlights'
    | 'saturation'
    | 'contrast'
    | 'curve'
    | 'noiseThreshold'
    | 'sharpen'
    | 'lensCorrection'
    | 'crop'
    | 'straighten'
  >,
) {
  const modules = new Map<string, NativeModule>();
  const add = (operation: string, version: number, params: Buffer, colorspace: number, enabled = true) =>
    modules.set(operation, { version, params, colorspace, enabled });
  if (recipe.shadows !== undefined || recipe.highlights !== undefined) {
    // shadhi.c v5: gaussian order, radius/shadows/whitepoint/highlights/reserved/compress/CC, flags, approximation, algorithm.
    const params = floats([0, 100, recipe.shadows ?? 0, 0, recipe.highlights ?? 0, 0, 50, 100, 50, 0, 0.000001, 0]);
    params.writeUInt32LE(127, 36); // UNBOUND_DEFAULT
    params.writeInt32LE(1, 44); // SHADHI_ALGO_BILATERAL
    add('shadhi', 5, params, 2);
  }
  if (recipe.saturation !== undefined || recipe.contrast !== undefined) {
    // colorbalance.c v3: SOP; native lift/gamma/gain neutral channels, saturation/contrast/grey/output saturation.
    const params = floats([
      0,
      ...Array.from({ length: 12 }, () => 1),
      recipe.saturation ?? 1,
      recipe.contrast ?? 1,
      18,
      1,
    ]);
    params.writeInt32LE(1, 0);
    add('colorbalance', 3, params, 2); // module's blend_colorspace is Lab.
  }
  if (recipe.curve) {
    // rgbcurve.c v1 + common/curve_tools.h: 3 * 20 pairs, node counts/types, autoscale/grey/norm.
    const params = Buffer.alloc(516);
    for (let channel = 0; channel < 3; channel++) {
      const points =
        channel === 0
          ? recipe.curve
          : [
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ];
      for (const [index, point] of points.entries()) {
        params.writeFloatLE(point.x, channel * 160 + index * 8);
        params.writeFloatLE(point.y, channel * 160 + index * 8 + 4);
      }
      params.writeInt32LE(points.length, 480 + channel * 4);
      params.writeInt32LE(2, 492 + channel * 4); // MONOTONE_HERMITE
    }
    params.writeInt32LE(1, 512); // DT_RGB_NORM_LUMINANCE
    add('rgbcurve', 1, params, 4);
  }
  if (recipe.noiseThreshold !== undefined) {
    // rawdenoise.c v2: threshold; 4 channels * 5 x/y bands, exactly as native init().
    const params = Buffer.alloc(164);
    params.writeFloatLE(recipe.noiseThreshold, 0);
    for (let channel = 0; channel < 4; channel++)
      for (let band = 0; band < 5; band++) {
        params.writeFloatLE(band / 4, 4 + (channel * 5 + band) * 4);
        params.writeFloatLE(0.5, 84 + (channel * 5 + band) * 4);
      }
    add('rawdenoise', 2, params, 0, recipe.noiseThreshold > 0);
  }
  if (recipe.sharpen)
    add(
      'sharpen',
      1,
      floats([recipe.sharpen.radius, recipe.sharpen.amount, recipe.sharpen.threshold]),
      2,
      recipe.sharpen.amount > 0,
    );
  if (recipe.lensCorrection !== undefined) {
    // lens.cc v10: has_been_set=FALSE tells commit_params to use real camera defaults.
    // Method 0 prefers embedded metadata, falls back to Lensfun; never synthesize camera/lens calibration.
    const params = Buffer.alloc(356);
    params.writeInt32LE(0, 0);
    params.writeInt32LE(7, 4);
    for (const offset of [12, 296, 300, 304, 308, 312, 316, 320, 328]) params.writeFloatLE(1, offset);
    params.writeFloatLE(0.5, 340);
    params.writeFloatLE(0.5, 344);
    add('lens', 10, params, 0, recipe.lensCorrection);
  }
  if (recipe.crop || recipe.straighten !== undefined) {
    const crop = recipe.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const params = floats([
      recipe.straighten ?? 0,
      crop.x,
      crop.y,
      crop.x + crop.w,
      crop.y + crop.h,
      0,
      0,
      0.2,
      0.2,
      0.8,
      0.2,
      0.8,
      0.8,
      0.2,
      0.8,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    params.writeInt32LE(1, 72); // native crop_auto prevents black corners after straightening
    params.writeInt32LE(-1, 76);
    params.writeInt32LE(-1, 80);
    add('clipping', 5, params, 0);
  }
  return modules;
}

/** develop/blend.h v14 + blend.c defaults; external raster ID is BLEND_RASTER_ID (0). */
export function nativeBlendParams(colorspace: number, rasterInstance?: number): Buffer {
  const params = Buffer.alloc(420);
  params.writeUInt32LE(rasterInstance === undefined ? 0 : 9, 0); // ENABLED | RASTER
  params.writeInt32LE(colorspace, 4);
  params.writeUInt32LE(0x18, 8); // NORMAL2 (unbounded)
  params.writeFloatLE(100, 16);
  params.writeUInt32LE(5, 36); // GUIDE_IN_AFTER_BLUR
  params.writeUInt32LE(1, 56); // feather_version
  for (let channel = 0; channel < 16; channel++) {
    params.writeFloatLE(1, 68 + channel * 16 + 8);
    params.writeFloatLE(1, 68 + channel * 16 + 12);
  }
  if (colorspace === 4) for (const channel of [8, 9, 12, 13]) params.writeFloatLE(-6.64385619, 324 + channel * 4);
  params.writeInt32LE(rasterInstance === undefined ? -1 : 0, 412);
  if (rasterInstance !== undefined) {
    params.write('rasterfile', 388, 'utf8');
    params.writeInt32LE(rasterInstance, 408);
  }
  return params;
}

// common/iop_order.c v50_order, default RAW pipeline (module_order.version=4).
export const NATIVE_RAW_ORDER = [
  'rawprepare',
  'invert',
  'temperature',
  'rasterfile',
  'highlights',
  'cacorrect',
  'hotpixels',
  'rawdenoise',
  'demosaic',
  'denoiseprofile',
  'bilateral',
  'rotatepixels',
  'scalepixels',
  'lens',
  'cacorrectrgb',
  'hazeremoval',
  'ashift',
  'flip',
  'enlargecanvas',
  'overlay',
  'clipping',
  'liquify',
  'spots',
  'retouch',
  'exposure',
  'mask_manager',
  'tonemap',
  'toneequal',
  'crop',
  'graduatednd',
  'profile_gamma',
  'equalizer',
  'colorin',
  'channelmixerrgb',
  'diffuse',
  'censorize',
  'negadoctor',
  'blurs',
  'primaries',
  'nlmeans',
  'colorchecker',
  'defringe',
  'atrous',
  'lowpass',
  'highpass',
  'sharpen',
  'colortransfer',
  'colormapping',
  'channelmixer',
  'basicadj',
  'colorharmonizer',
  'colorbalance',
  'colorequal',
  'colorbalancergb',
  'rgbcurve',
  'rgblevels',
  'basecurve',
  'filmic',
  'sigmoid',
  'agx',
  'filmicrgb',
  'lut3d',
  'colisa',
  'tonecurve',
  'levels',
  'shadhi',
  'zonesystem',
  'globaltonemap',
  'relight',
  'bilat',
  'colorcorrection',
  'colorcontrast',
  'velvia',
  'vibrance',
  'colorzones',
  'bloom',
  'colorize',
  'lowlight',
  'monochrome',
  'grain',
  'soften',
  'splittoning',
  'vignette',
  'colorreconstruct',
  'finalscale',
  'colorout',
  'clahe',
  'overexposed',
  'rawoverexposed',
  'dither',
  'borders',
  'watermark',
  'gamma',
];
