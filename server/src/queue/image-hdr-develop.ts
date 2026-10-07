/* Relative imports are required by the standalone image worker. */
/* eslint-disable no-restricted-imports */
import { ASSET_DEVELOP_BITMAP_MASK_KINDS, AssetDevelopMaskKind } from './develop-values.js';
import type { LinearHdrImage } from './image-hdr.js';
import { SharpResourceLimitError } from './sharp-protocol.js';
import { type DevelopBitmap, type DevelopLinearFill, orientedToOriginal } from '../utils/develop-cleanup.js';
import {
  type DevelopGeometryPlan,
  createNoise,
  defaultDevelopRecipe,
  effectiveDevelop,
  isActiveMask,
  maskWeight,
  originalMaskWeight,
  straightenScale,
} from '../utils/develop-recipe.js';
import type { AssetDevelopMask, KnownAssetDevelopRecipe } from 'src/dtos/asset-develop.dto.js';

/** Verified fill artifacts are sRGB. Convert before compositing, then premultiply for filtered sampling. */
export function linearizeDevelopFill(fill: DevelopBitmap, gamut: 0 | 1 | 2, maxBytes: number): DevelopLinearFill {
  const count = fill.width * fill.height;
  if (fill.channels !== 4 || !Number.isSafeInteger(count) || count < 1 || fill.data.length !== count * 4) {
    throw new TypeError('HDR cleanup requires a normalized RGBA fill');
  }
  if (!Number.isSafeInteger(maxBytes) || count * 16 + fill.data.byteLength > maxBytes) {
    throw new SharpResourceLimitError('HDR fill exceeds the float surface budget');
  }
  // D65 sRGB -> source primaries, composed from CSS Color 4 RGB/XYZ matrices.
  // https://www.w3.org/TR/css-color-4/#color-conversion-code
  const matrix =
    gamut === 1
      ? [
          0.822461968714362, 0.177538031285638, 0, 0.0331941988509617, 0.966805801149038, 0, 0.01708263072112,
          0.0723974406639637, 0.910519928614916,
        ]
      : gamut === 2
        ? [
            0.627403895934699, 0.329283038377884, 0.0433130656874173, 0.0690972893582321, 0.919540395075459,
            0.0113623155663089, 0.0163914388751503, 0.0880133078772258, 0.895595253247624,
          ]
        : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const data = new Float32Array(count * 4);
  for (let i = 0; i < data.length; i += 4) {
    const r = linear(fill.data[i] / 255);
    const g = linear(fill.data[i + 1] / 255);
    const b = linear(fill.data[i + 2] / 255);
    const alpha = fill.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) {
      const offset = c * 3;
      data[i + c] = (r * matrix[offset] + g * matrix[offset + 1] + b * matrix[offset + 2]) * alpha;
    }
    data[i + 3] = alpha;
  }
  return { data, width: fill.width, height: fill.height, channels: 4 };
}

/** One inverse transform in linear light, without integer surfaces or SDR clipping. */
export function transformHdrGeometry(
  image: LinearHdrImage,
  plan: DevelopGeometryPlan,
  maxBytes: number,
): LinearHdrImage {
  const { width, height } = plan.output;
  const bytes = width * height * 16;
  if (
    !Number.isSafeInteger(bytes) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    image.data.length !== image.width * image.height * 16 ||
    !Number.isSafeInteger(maxBytes) ||
    image.data.length + bytes > maxBytes
  ) {
    throw new SharpResourceLimitError('HDR geometry exceeds the float surface budget');
  }
  const source = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
  const output = new Float32Array(width * height * 4);
  const angle = (plan.straighten * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const scale = straightenScale(plan.oriented.width, plan.oriented.height, plan.straighten);
  const cx = plan.oriented.width / 2;
  const cy = plan.oriented.height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = plan.extract.left + x + 0.5 - cx;
      const dy = plan.extract.top + y + 0.5 - cy;
      const point = orientedToOriginal((dx * cos + dy * sin) / scale + cx, (-dx * sin + dy * cos) / scale + cy, plan);
      const sx = Math.max(0, Math.min(image.width - 1, point.x - 0.5));
      const sy = Math.max(0, Math.min(image.height - 1, point.y - 0.5));
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(x0 + 1, image.width - 1);
      const y1 = Math.min(y0 + 1, image.height - 1);
      const fx = sx - x0;
      const fy = sy - y0;
      const destination = (y * width + x) * 4;
      let alpha = 0;
      for (let sampleY = 0; sampleY < 2; sampleY++) {
        for (let sampleX = 0; sampleX < 2; sampleX++) {
          const index = ((sampleY === 0 ? y0 : y1) * image.width + (sampleX === 0 ? x0 : x1)) * 4;
          const weight = (sampleX === 0 ? 1 - fx : fx) * (sampleY === 0 ? 1 - fy : fy) * source[index + 3];
          alpha += weight;
          for (let channel = 0; channel < 3; channel++) {
            output[destination + channel] += source[index + channel] * weight;
          }
        }
      }
      if (alpha > 0) {
        for (let channel = 0; channel < 3; channel++) output[destination + channel] /= alpha;
      }
      output[destination + 3] = alpha;
    }
  }
  return { ...image, width, height, data: Buffer.from(output.buffer, output.byteOffset, output.byteLength) };
}

/** HDR renderer v1: linear exposure, luminance-weighted stops and unbounded chroma. */
export function applyHdrDevelopTone(image: LinearHdrImage, recipe: KnownAssetDevelopRecipe, seed = 1): LinearHdrImage {
  const { params, look } = effectiveDevelop(recipe);
  const data = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
  // UHD gamut ids: BT.709, Display P3, BT.2020.
  const weights =
    image.gamut === 2
      ? [0.2627, 0.678, 0.0593]
      : image.gamut === 1
        ? [0.2289746, 0.6917385, 0.0792869]
        : [0.2126, 0.7152, 0.0722];
  const exposure = 2 ** params.exposure;
  const warm = params.temperature / 100;
  const tint = params.tint / 100;
  const gains = [(1 + 0.18 * warm) * (1 + 0.06 * tint), 1 - 0.12 * tint, (1 - 0.18 * warm) * (1 + 0.06 * tint)];
  const contrast = 1 + params.contrast * 0.006 + Math.max(0, params.dehaze) * 0.003;
  const noise = createNoise(seed);
  const halfWidth = image.width / 2;
  const halfHeight = image.height / 2;
  const cornerDistance = Math.hypot(halfWidth, halfHeight);
  const smooth = (low: number, high: number, value: number) => {
    const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i] * exposure * gains[0];
    let g = data[i + 1] * exposure * gains[1];
    let b = data[i + 2] * exposure * gains[2];
    let luma = Math.max(0, r * weights[0] + g * weights[1] + b * weights[2]);
    const brightness = luma / (1 + luma);
    const highlightMask = smooth(0.3, 0.8, brightness);
    const shadowMask = 1 - smooth(0, 0.35, brightness);
    const midtoneMask = 4 * brightness * (1 - brightness);
    const stops =
      (params.highlights / 100) * highlightMask +
      (params.shadows / 100) * shadowMask +
      (params.whites / 100) * brightness +
      (params.brilliance / 100) * midtoneMask * (1 - 2 * brightness);
    let factor = 2 ** stops;
    if (contrast !== 1 && luma > 0) factor *= (luma / 0.18) ** (contrast - 1);
    r *= factor;
    g *= factor;
    b *= factor;
    const blackLift = ((params.blacks / 100) * 0.04 - (params.dehaze / 100) * 0.02) * shadowMask;
    r += blackLift;
    g += blackLift;
    b += blackLift;
    luma = r * weights[0] + g * weights[1] + b * weights[2];
    const maximum = Math.max(r, g, b);
    const saturation = maximum > 0 ? (maximum - Math.min(r, g, b)) / maximum : 0;
    const chroma = (1 + params.saturation / 100) * (1 + (params.vibrance / 100) * 0.9 * (1 - saturation));
    r = luma + (r - luma) * chroma;
    g = luma + (g - luma) * chroma;
    b = luma + (b - luma) * chroma;
    if (look.grayscale) {
      const grey = look.grayscale / 100;
      r += (luma - r) * grey;
      g += (luma - g) * grey;
      b += (luma - b) * grey;
    }
    if (look.sepia) {
      const amount = look.sepia / 100;
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r += (sr - r) * amount;
      g += (sg - g) * amount;
      b += (sb - b) * amount;
    }
    if (params.vignette) {
      const pixel = i / 4;
      const distance =
        Math.hypot((pixel % image.width) + 0.5 - halfWidth, Math.floor(pixel / image.width) + 0.5 - halfHeight) /
        cornerDistance;
      factor = 2 ** ((-params.vignette / 100) * 2 * smooth(0.35, 1, distance));
      r *= factor;
      g *= factor;
      b *= factor;
    }
    if (params.grain) {
      const grain = (((noise() - 0.5) * params.grain) / 100) * 0.04 * Math.sqrt(Math.max(0, luma));
      r += grain;
      g += grain;
      b += grain;
    }
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
  return image;
}

/** Selective tone uses the same float math; mask coordinates retain the existing recipe semantics. */
export function applyHdrDevelopMasks(
  image: LinearHdrImage,
  masks: AssetDevelopMask[],
  plan: DevelopGeometryPlan,
  maxBytes: number,
  bitmaps: ReadonlyMap<string, DevelopBitmap> = new Map(),
): LinearHdrImage {
  const active = masks.filter((mask) => isActiveMask(mask));
  if (active.length === 0) return image;
  const original = orientedToOriginal(0, 0, plan).original;
  const coverageCount = active.filter(
    (mask) => mask.kind === AssetDevelopMaskKind.Brush || !!mask.strokes?.length,
  ).length;
  // Caches retain one surface per mask; refinement also holds initial and per-stroke surfaces.
  const coverageBytes = original.width * original.height * 4 * (coverageCount ? coverageCount + 2 : 0);
  let artifactBytes = 0;
  for (const bitmap of bitmaps.values()) artifactBytes += bitmap.data.byteLength;
  if (!Number.isSafeInteger(maxBytes) || image.data.length * 2 + coverageBytes + artifactBytes > maxBytes) {
    throw new SharpResourceLimitError('HDR masks exceed the float surface budget');
  }
  for (const mask of active) {
    if (ASSET_DEVELOP_BITMAP_MASK_KINDS.includes(mask.kind) && (!mask.artifact || !bitmaps.has(mask.artifact))) {
      throw new Error('HDR selective adjustment requires its verified mask artifact');
    }
  }
  const scratch = Buffer.alloc(image.data.length);
  const data = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
  const adjusted = new Float32Array(scratch.buffer, scratch.byteOffset, scratch.length / 4);
  const { width: ow, height: oh } = plan.oriented;
  const angle = (plan.straighten * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const scale = straightenScale(ow, oh, plan.straighten);
  for (const mask of active) {
    image.data.copy(scratch);
    applyHdrDevelopTone({ ...image, data: scratch }, { ...defaultDevelopRecipe(), ...mask.adjustments });
    for (let y = 0; y < image.height; y++) {
      for (let x = 0; x < image.width; x++) {
        const dx = plan.extract.left + x + 0.5 - ow / 2;
        const dy = plan.extract.top + y + 0.5 - oh / 2;
        const ox = (dx * cos + dy * sin) / scale + ow / 2;
        const oy = (-dx * sin + dy * cos) / scale + oh / 2;
        let weight: number;
        if (mask.kind === AssetDevelopMaskKind.Radial || mask.kind === AssetDevelopMaskKind.Linear) {
          weight = maskWeight(mask, ox / ow, oy / oh, ow / oh);
        } else {
          const point = orientedToOriginal(ox, oy, plan);
          weight = originalMaskWeight(mask, point.x, point.y, original, bitmaps);
        }
        weight *= mask.amount / 100;
        const index = (y * image.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          data[index + channel] += (adjusted[index + channel] - data[index + channel]) * weight;
        }
      }
    }
  }
  return image;
}

/** Linear detail, with reusable premultiplied filter surfaces and no integer or SDR intermediates. */
export function applyHdrDevelopDetail(
  image: LinearHdrImage,
  recipe: KnownAssetDevelopRecipe,
  maxBytes: number,
): LinearHdrImage {
  const { params } = effectiveDevelop(recipe);
  if (!params.noiseReduction && !params.sharpen && !params.clarity) return image;
  if (!Number.isSafeInteger(maxBytes) || image.data.length * 3 > maxBytes) {
    throw new SharpResourceLimitError('HDR detail exceeds the float surface budget');
  }
  const pixels = new Float32Array(image.data.buffer, image.data.byteOffset, image.data.length / 4);
  const a = new Float32Array(pixels.length);
  const b = new Float32Array(pixels.length);
  const weights =
    image.gamut === 2
      ? [0.2627, 0.678, 0.0593]
      : image.gamut === 1
        ? [0.2289746, 0.6917385, 0.0792869]
        : [0.2126, 0.7152, 0.0722];
  const box = (input: Float32Array, output: Float32Array, radius: number, horizontal: boolean) => {
    const length = horizontal ? image.width : image.height;
    const lines = horizontal ? image.height : image.width;
    const stride = horizontal ? 4 : image.width * 4;
    const divisor = radius * 2 + 1;
    for (let line = 0; line < lines; line++) {
      const start = line * (horizontal ? image.width : 1) * 4;
      // Double sums retain precision when the sliding window removes bright HDR samples.
      const sums = [0, 0, 0, 0];
      for (let offset = -radius; offset <= radius; offset++) {
        const index = start + Math.max(0, Math.min(length - 1, offset)) * stride;
        for (let c = 0; c < 4; c++) sums[c] += input[index + c];
      }
      for (let position = 0; position < length; position++) {
        const index = start + position * stride;
        const remove = start + Math.max(0, position - radius) * stride;
        const add = start + Math.min(length - 1, position + radius + 1) * stride;
        for (let c = 0; c < 4; c++) {
          output[index + c] = sums[c] / divisor;
          sums[c] += input[add + c] - input[remove + c];
        }
      }
    }
  };
  const blur = (sigma: number) => {
    for (let i = 0; i < pixels.length; i += 4) {
      for (let c = 0; c < 3; c++) a[i + c] = pixels[i + c] * pixels[i + 3];
      a[i + 3] = pixels[i + 3];
    }
    // Three variance-matched box passes approximate a Gaussian in O(pixels), independent of radius.
    const ideal = Math.sqrt(4 * sigma * sigma + 1);
    let lower = Math.floor(ideal);
    if (lower % 2 === 0) lower--;
    const upper = lower + 2;
    const lowerCount = Math.round((12 * sigma * sigma - 3 * lower * lower - 12 * lower - 9) / (-4 * lower - 4));
    for (let pass = 0; pass < 3; pass++) {
      const radius = ((pass < lowerCount ? lower : upper) - 1) / 2;
      box(a, b, radius, true);
      box(b, a, radius, false);
    }
  };
  const stages = [
    { amount: params.noiseReduction / 100, sigma: 0.4 + (params.noiseReduction / 100) * 0.8, kind: 'noise' },
    { amount: (params.sharpen / 100) * 1.6, sigma: 0.8 + (params.sharpen / 100) * 1.2, kind: 'sharpen' },
    {
      amount: params.clarity / 100,
      sigma: Math.max(2, Math.min(24, Math.min(image.width, image.height) / 160)),
      kind: 'clarity',
    },
  ];
  for (const stage of stages) {
    if (!stage.amount) continue;
    blur(stage.sigma);
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] <= 0 || a[i + 3] <= 0) continue;
      const luma = pixels[i] * weights[0] + pixels[i + 1] * weights[1] + pixels[i + 2] * weights[2];
      const blurredLuma = (a[i] * weights[0] + a[i + 1] * weights[1] + a[i + 2] * weights[2]) / a[i + 3];
      let amount = stage.amount;
      if (stage.kind === 'noise') {
        const tolerance = 0.025 + 0.06 * Math.sqrt(Math.max(0, luma));
        amount *= Math.exp(-(((luma - blurredLuma) / tolerance) ** 2));
        for (let c = 0; c < 3; c++) pixels[i + c] += (a[i + c] / a[i + 3] - pixels[i + c]) * amount;
      } else if (stage.kind === 'sharpen') {
        for (let c = 0; c < 3; c++) pixels[i + c] += (pixels[i + c] - a[i + c] / a[i + 3]) * amount;
      } else {
        const brightness = Math.max(0, luma) / (1 + Math.max(0, luma));
        const delta = (luma - blurredLuma) * amount * 4 * brightness * (1 - brightness);
        // Luminance contrast preserves hue; alpha stays the source alpha.
        if (luma > 1e-6) {
          const gain = (luma + delta) / luma;
          for (let c = 0; c < 3; c++) pixels[i + c] *= gain;
        }
      }
    }
  }
  return image;
}
