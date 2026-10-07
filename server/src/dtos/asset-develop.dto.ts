import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { ExtraModel } from 'src/decorators.js';
import { ApiCustomExtension } from 'src/enum.js';

import {
  ASSET_DEVELOP_BITMAP_MASK_KINDS,
  ASSET_DEVELOP_MAX_CLEANUP,
  ASSET_DEVELOP_MAX_MASKS,
  ASSET_DEVELOP_MAX_RECIPE_POINTS,
  ASSET_DEVELOP_MAX_STROKES,
  ASSET_DEVELOP_MAX_STROKE_POINTS,
  ASSET_DEVELOP_RECIPE_VERSION,
  AssetDevelopCleanupMethod,
  AssetDevelopMaskKind,
  AssetDevelopPreset,
} from 'src/queue/develop-values.js';

export {
  ASSET_DEVELOP_BITMAP_MASK_KINDS,
  ASSET_DEVELOP_MAX_CLEANUP,
  ASSET_DEVELOP_MAX_MASKS,
  ASSET_DEVELOP_MAX_RECIPE_POINTS,
  ASSET_DEVELOP_MAX_STROKES,
  ASSET_DEVELOP_MAX_STROKE_POINTS,
  ASSET_DEVELOP_RECIPE_VERSION,
  AssetDevelopCleanupMethod,
  AssetDevelopMaskKind,
  AssetDevelopPreset,
} from 'src/queue/develop-values.js';

/**
 * The still-image edit recipe (FL-113). A recipe is the complete, versioned description of a
 * quick edit: develop sliders, the chosen look and its strength, and the geometry (crop,
 * straighten, quarter-turn rotation, flips). It is stored as a revision against the asset and
 * rendered by the server into an edited master plus a preview; the original is never touched.
 *
 * Ranges follow the design prototype's `develop.mjs` so the client and the renderer agree on
 * the meaning of every value. `version` is the contract version of the recipe shape itself.
 */

export const AssetDevelopPresetSchema = z
  .enum(AssetDevelopPreset)
  .describe('Named look applied on top of the develop sliders')
  .meta({ id: 'AssetDevelopPreset' });

export enum AssetDevelopRevisionStatus {
  /** Recipe stored, no render requested. */
  Saved = 'saved',
  Queued = 'queued',
  Rendering = 'rendering',
  Rendered = 'rendered',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export const AssetDevelopRevisionStatusSchema = z
  .enum(AssetDevelopRevisionStatus)
  .describe('Render state of a develop revision')
  .meta({ id: 'AssetDevelopRevisionStatus' });

export enum AssetDevelopRevisionKind {
  /** A recipe rendered by the server from the original. */
  Recipe = 'recipe',
  /** A finished file developed outside Frameleaf from an exported original and brought back (FL-64). */
  External = 'external',
}

export const AssetDevelopRevisionKindSchema = z
  .enum(AssetDevelopRevisionKind)
  .describe('How a develop version was produced')
  .meta({ id: 'AssetDevelopRevisionKind' });

export enum AssetDevelopFileKind {
  Master = 'master',
  Preview = 'preview',
}

export const AssetDevelopFileKindSchema = z
  .enum(AssetDevelopFileKind)
  .describe('Which rendered file of a revision to fetch')
  .meta({ id: 'AssetDevelopFileKind' });

const bipolar = (description: string) =>
  z.number().meta({ format: 'double' }).min(-100).max(100).default(0).describe(description);
const unipolar = (description: string) =>
  z.number().meta({ format: 'double' }).min(0).max(100).default(0).describe(description);
const unit = (description: string) => z.number().meta({ format: 'double' }).min(0).max(1).describe(description);

export const AssetDevelopCropSchema = z
  .object({
    x: unit('Left edge of the crop as a fraction of the oriented frame width'),
    y: unit('Top edge of the crop as a fraction of the oriented frame height'),
    w: z.number().meta({ format: 'double' }).min(0.05).max(1).describe('Crop width as a fraction of the frame'),
    h: z.number().meta({ format: 'double' }).min(0.05).max(1).describe('Crop height as a fraction of the frame'),
  })
  .refine((rect) => rect.x + rect.w <= 1.00001 && rect.y + rect.h <= 1.00001, {
    error: 'Crop must stay inside the frame',
  })
  // the envelope's own (loose) crop is published as AssetDevelopCrop
  .meta({ id: 'KnownAssetDevelopCrop' });

export const AssetDevelopMaskKindSchema = z
  .enum(AssetDevelopMaskKind)
  .describe('Shape of a selective adjustment mask')
  .meta({ id: 'AssetDevelopMaskKind' });

/** FL-233: how many stroke points a recipe's masks and Clean Up carry together. */
export const recipeStrokePoints = (value: { masks?: unknown; cleanup?: unknown }) => {
  let total = 0;
  for (const list of [value.masks, value.cleanup]) {
    for (const item of Array.isArray(list) ? list : []) {
      const strokes = item && typeof item === 'object' ? (item as { strokes?: unknown }).strokes : undefined;
      for (const stroke of Array.isArray(strokes) ? strokes : []) {
        const points = stroke && typeof stroke === 'object' ? (stroke as { points?: unknown }).points : undefined;
        total += Array.isArray(points) ? points.length : 0;
      }
    }
  }
  return total;
};

/** FL-233: a stored develop artifact (mask bitmap or generated fill): the SHA-256 of its PNG bytes. */
export const AssetDevelopArtifactIdSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('A develop artifact uploaded for this asset: the lowercase hex SHA-256 of its stored PNG');

const OriginalPointSchema = z
  .tuple([z.number().meta({ format: 'double' }).min(0).max(1), z.number().meta({ format: 'double' }).min(0).max(1)])
  .describe('A point as [x, y] fractions of the original image (before rotation, flips and crop)');

/**
 * FL-233: one painted stroke, a polyline in original-image coordinates (fractions of the original's
 * width and height, before any rotation, flip, straighten or crop). `radius` is a fraction of the
 * original's shorter side.
 */
export const AssetDevelopStrokeSchema = z
  .object({
    points: z.array(OriginalPointSchema).min(1).max(ASSET_DEVELOP_MAX_STROKE_POINTS),
    radius: z
      .number()
      .meta({ format: 'double' })
      .min(0.001)
      .max(0.5)
      .describe("Stroke radius as a fraction of the original image's shorter side"),
    erase: z.boolean().default(false).describe('Erase from the mask instead of painting it (brush masks only)'),
  })
  .meta({ id: 'AssetDevelopStroke' });

/** FL-233: a rectangle in original-image coordinates. */
export const AssetDevelopRegionSchema = z
  .object({
    x: unit('Left edge as a fraction of the original image width'),
    y: unit('Top edge as a fraction of the original image height'),
    w: z.number().meta({ format: 'double' }).min(0.001).max(1).describe('Width as a fraction of the original'),
    h: z.number().meta({ format: 'double' }).min(0.001).max(1).describe('Height as a fraction of the original'),
  })
  .refine((rect) => rect.x + rect.w <= 1.00001 && rect.y + rect.h <= 1.00001, {
    error: 'A region must stay inside the image',
  })
  .meta({ id: 'AssetDevelopRegion' });

export const AssetDevelopCleanupMethodSchema = z
  .enum(AssetDevelopCleanupMethod)
  .describe('How a Clean Up operation changes its area')
  .meta({ id: 'AssetDevelopCleanupMethod' });

/**
 * FL-233: one Clean Up operation. Operations apply in order to the original image, before any other
 * develop step, over the area of `region` or `strokes` (exactly one of them).
 */
export const AssetDevelopCleanupSchema = z
  .object({
    id: z.string().trim().min(1).max(40).describe('Client-chosen identifier, unique within the recipe'),
    method: AssetDevelopCleanupMethodSchema,
    enabled: z.boolean().default(true).describe('A disabled operation is kept but not rendered'),
    region: AssetDevelopRegionSchema.optional(),
    strokes: z.array(AssetDevelopStrokeSchema).min(1).max(ASSET_DEVELOP_MAX_STROKES).optional(),
    feather: z.int().min(0).max(100).default(0).describe("Softness of the area's edge, as a percentage"),
    source: z
      .object({
        dx: z.number().meta({ format: 'double' }).min(-1).max(1).describe('Horizontal offset, fraction of the width'),
        dy: z.number().meta({ format: 'double' }).min(-1).max(1).describe('Vertical offset, fraction of the height'),
      })
      .optional()
      .describe('Heal and clone: where the pixels come from, relative to the area, in original-image fractions'),
    fill: AssetDevelopArtifactIdSchema.optional().describe(
      'Remove: the generated fill, an RGBA artifact covering the bounding box of the area',
    ),
    blockSize: z
      .number()
      .meta({ format: 'double' })
      .min(0.002)
      .max(0.2)
      .default(0.02)
      .describe("Pixelate: block size as a fraction of the original image's shorter side"),
  })
  .refine((op) => (op.region === undefined) !== (op.strokes === undefined), {
    error: 'A Clean Up operation needs exactly one of region or strokes',
  })
  .refine(
    (op) =>
      (op.method !== AssetDevelopCleanupMethod.Heal && op.method !== AssetDevelopCleanupMethod.Clone) ||
      (op.source !== undefined && (op.source.dx !== 0 || op.source.dy !== 0)),
    { error: 'Heal and clone need a source offset' },
  )
  .refine((op) => op.method !== AssetDevelopCleanupMethod.Remove || op.fill !== undefined, {
    error: 'Remove needs a generated fill',
  })
  .meta({ id: 'AssetDevelopCleanup' });

/**
 * What a selective adjustment changes inside its mask (FL-64). Only the per-pixel tone and colour
 * controls are offered: the spatial ones (clarity, sharpening, noise reduction, vignette, grain)
 * stay global, which keeps a mask's effect exactly the blend of two tone results.
 */
export const AssetDevelopMaskAdjustmentsSchema = z
  .object({
    exposure: z
      .number()
      .meta({ format: 'double' })
      .min(-2)
      .max(2)
      .default(0)
      .describe('Exposure in EV inside the mask'),
    contrast: bipolar('Contrast inside the mask'),
    highlights: bipolar('Highlights inside the mask'),
    shadows: bipolar('Shadows inside the mask'),
    whites: bipolar('White point inside the mask'),
    blacks: bipolar('Black point inside the mask'),
    temperature: bipolar('White balance shift inside the mask'),
    tint: bipolar('Tint inside the mask'),
    vibrance: bipolar('Vibrance inside the mask'),
    saturation: bipolar('Saturation inside the mask'),
    dehaze: bipolar('Dehaze inside the mask'),
  })
  .meta({ id: 'AssetDevelopMaskAdjustments' });

/**
 * One selective adjustment (FL-64). Coordinates are fractions of the oriented frame (after the
 * quarter turns and flips, before straightening and the crop) — the same space as `crop` — so a
 * mask stays on the part of the picture it was drawn over when the crop changes.
 *
 * A radial mask is centred on (`x`, `y`) with radii `radiusX` and `radiusY`. A linear mask runs
 * from (`x`, `y`), where the effect is full, to (`endX`, `endY`), where it has faded out; the
 * radius fields are ignored for it and the end fields for a radial mask.
 */
/** The mask fields without the cross-field checks (FL-233: presets narrow `kind`). */
export const AssetDevelopMaskFields = z.object({
  id: z.string().trim().min(1).max(40).describe('Client-chosen identifier, unique within the recipe'),
  name: z.string().trim().min(1).max(60).nullable().default(null).describe('Optional name shown in the editor'),
  kind: AssetDevelopMaskKindSchema,
  enabled: z.boolean().default(true).describe('A disabled mask is kept but not rendered'),
  invert: z.boolean().default(false).describe('Apply the adjustment outside the shape instead of inside'),
  x: unit('Centre (radial) or start (linear) across the oriented frame; any value for brush and bitmap masks'),
  y: unit('Centre (radial) or start (linear) down the oriented frame; any value for brush and bitmap masks'),
  radiusX: z
    .number()
    .meta({ format: 'double' })
    .min(0.01)
    .max(1)
    .default(0.25)
    .describe('Horizontal radius of a radial mask as a fraction of the frame width'),
  radiusY: z
    .number()
    .meta({ format: 'double' })
    .min(0.01)
    .max(1)
    .default(0.25)
    .describe('Vertical radius of a radial mask as a fraction of the frame height'),
  endX: unit('Where a linear mask has faded out, across the frame').default(0.5),
  endY: unit('Where a linear mask has faded out, down the frame').default(1),
  feather: z
    .int()
    .min(0)
    .max(100)
    .default(50)
    .describe('Softness of a radial edge as a percentage of the radius, or of a brush stroke as one of its radius'),
  strokes: z
    .array(AssetDevelopStrokeSchema)
    .max(ASSET_DEVELOP_MAX_STROKES)
    .optional()
    .describe('Brush masks: the painted strokes, in order'),
  artifact: AssetDevelopArtifactIdSchema.nullable()
    .optional()
    .describe('Subject, sky and background masks: the stored greyscale mask bitmap, covering the whole original image'),
  detector: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Subject, sky and background masks: an opaque descriptor that lets a client detect the mask again; the server never runs it',
    ),
  amount: z.int().min(0).max(100).default(100).describe('How much of the adjustment is applied, as a percentage'),
  adjustments: AssetDevelopMaskAdjustmentsSchema.default({
    exposure: 0,
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
  }),
});

export const AssetDevelopMaskSchema = AssetDevelopMaskFields.refine(
  (mask) => mask.kind !== AssetDevelopMaskKind.Linear || mask.x !== mask.endX || mask.y !== mask.endY,
  { error: 'A linear mask needs different start and end points' },
)
  .refine((mask) => mask.kind === AssetDevelopMaskKind.Brush || mask.strokes === undefined, {
    error: 'Only a brush mask has strokes',
  })
  .refine(
    (mask) =>
      ASSET_DEVELOP_BITMAP_MASK_KINDS.includes(mask.kind) ||
      (mask.artifact === undefined && mask.detector === undefined),
    { error: 'Only subject, sky and background masks have an artifact or detector' },
  )
  .meta({ id: 'AssetDevelopMask' });

/** Native controls are explicit darktable units; version 1 remains the quick-edit protocol. */
const NativeCurveSchema = z
  .array(z.strictObject({ x: unit('Input'), y: unit('Output') }))
  .min(2)
  .max(20)
  .refine(
    (points) =>
      points[0].x === 0 &&
      points.at(-1)!.x === 1 &&
      points.every((point, i) => i === 0 || point.x - points[i - 1].x >= 0.0025),
    { error: 'Curves need x coordinates at least 0.0025 apart with endpoints at 0 and 1' },
  );
const NativeToneFields = {
  exposureEV: z.number().meta({ format: 'double' }).min(-18).max(18).default(0),
  shadows: z.number().meta({ format: 'double' }).min(-100).max(100).optional(),
  highlights: z.number().meta({ format: 'double' }).min(-100).max(100).optional(),
  saturation: z.number().meta({ format: 'double' }).min(0).max(2).optional(),
  contrast: z.number().meta({ format: 'double' }).min(0.01).max(1.99).optional(),
  curve: NativeCurveSchema.optional(),
};
const NativeMaskSchema = AssetDevelopMaskFields.omit({ adjustments: true, detector: true })
  .extend({
    coordinates: z.literal('sensor-active'),
    adjustments: z.strictObject(NativeToneFields),
    strokes: z.array(AssetDevelopStrokeSchema.strict()).max(ASSET_DEVELOP_MAX_STROKES).optional(),
  })
  .strict()
  .refine((mask) => mask.kind !== AssetDevelopMaskKind.Linear || mask.x !== mask.endX || mask.y !== mask.endY, {
    error: 'A gradient needs distinct endpoints',
  })
  .refine((mask) => mask.kind !== AssetDevelopMaskKind.Brush || !mask.enabled || !!mask.strokes?.length, {
    error: 'A brush needs strokes',
  })
  .refine((mask) => !ASSET_DEVELOP_BITMAP_MASK_KINDS.includes(mask.kind) || !!mask.artifact, {
    error: 'A raster mask needs an uploaded artifact',
  })
  .refine(
    (mask) =>
      mask.kind === AssetDevelopMaskKind.Brush || ASSET_DEVELOP_BITMAP_MASK_KINDS.includes(mask.kind) || !mask.strokes,
    { error: 'Only brush and raster masks have refinement strokes' },
  )
  .refine((mask) => ASSET_DEVELOP_BITMAP_MASK_KINDS.includes(mask.kind) || !mask.artifact, {
    error: 'Only raster masks have artifacts',
  });

export const DarktableDevelopRecipeSchema = z
  .strictObject({
    version: z.literal(2).meta({ type: 'integer', format: 'int32' }),
    renderer: z.literal('darktable/5.6.1'),
    ...NativeToneFields,
    whiteBalance: z
      .strictObject({
        red: z.number().meta({ format: 'double' }).min(0.1).max(8),
        green: z.number().meta({ format: 'double' }).min(0.1).max(8),
        blue: z.number().meta({ format: 'double' }).min(0.1).max(8),
      })
      .optional()
      .describe('Multipliers of native camera white-balance coefficients, not Kelvin estimates'),
    noiseThreshold: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .max(1)
      .optional()
      .describe('Native pre-demosaic wavelet noise threshold'),
    sharpen: z
      .strictObject({
        radius: z.number().meta({ format: 'double' }).min(0).max(99),
        amount: z.number().meta({ format: 'double' }).min(0).max(2),
        threshold: z.number().meta({ format: 'double' }).min(0).max(100),
      })
      .optional(),
    lensCorrection: z
      .boolean()
      .optional()
      .describe('Use native embedded metadata or Lensfun; refuse absent calibration'),
    crop: AssetDevelopCropSchema.strict().optional(),
    straighten: z.number().meta({ format: 'double' }).min(-45).max(45).optional(),
    rotation: z
      .union([
        z.literal(0).meta({ type: 'integer', format: 'int32' }),
        z.literal(90).meta({ type: 'integer', format: 'int32' }),
        z.literal(180).meta({ type: 'integer', format: 'int32' }),
        z.literal(270).meta({ type: 'integer', format: 'int32' }),
      ])
      .optional()
      .describe('Additional clockwise rotation after camera orientation'),
    flipHorizontal: z.boolean().optional(),
    flipVertical: z.boolean().optional(),
    sensorCanvas: z
      .boolean()
      .optional()
      .describe('Unrotated, uncropped, uncorrected canvas for selecting sensor-space masks'),
    masks: z
      .array(NativeMaskSchema)
      .max(ASSET_DEVELOP_MAX_MASKS)
      .refine((masks) => new Set(masks.map((mask) => mask.id)).size === masks.length, {
        error: 'Mask identifiers must be unique',
      })
      .optional(),
  })
  .refine((recipe) => recipeStrokePoints(recipe) <= ASSET_DEVELOP_MAX_RECIPE_POINTS, {
    error: 'Too many mask stroke points',
  })
  .meta({ id: 'DarktableDevelopRecipe' });
export type DarktableDevelopRecipe = z.infer<typeof DarktableDevelopRecipeSchema>;
export type DarktableDevelopMask = NonNullable<DarktableDevelopRecipe['masks']>[number];

/** The recipe fields without the whole-recipe checks, for `.pick` and the envelope's shape. */
export const KnownAssetDevelopRecipeFields = z.object({
  version: z.literal(ASSET_DEVELOP_RECIPE_VERSION).meta({ format: 'double' }).describe('Recipe contract version'),
  exposure: z
    .number()
    .meta({ format: 'double' })
    .min(-2)
    .max(2)
    .default(0)
    .describe('Exposure in EV; each whole stop doubles the light'),
  contrast: bipolar('Contrast around middle grey'),
  brilliance: bipolar(
    'FL-233: opens the shadows and holds back the highlights (positive), or the reverse (negative), with a slight colour lift; see the develop recipe protocol',
  ),
  highlights: bipolar('Highlight recovery (negative) or lift (positive)'),
  shadows: bipolar('Shadow lift (positive) or deepening (negative)'),
  whites: bipolar('White point'),
  blacks: bipolar('Black point'),
  temperature: bipolar('Warm (positive) or cool (negative) white balance shift'),
  tint: bipolar('Magenta (positive) or green (negative) tint'),
  vibrance: bipolar('Saturation weighted towards muted colours'),
  saturation: bipolar('Global saturation'),
  clarity: bipolar('Local contrast in the midtones'),
  dehaze: bipolar('Haze removal (positive) or addition (negative)'),
  vignette: bipolar('Darkened (positive) or lightened (negative) edges'),
  grain: unipolar('Film grain amount'),
  sharpen: unipolar('Detail sharpening amount'),
  noiseReduction: unipolar('Luminance noise reduction amount'),
  crop: AssetDevelopCropSchema.default({ x: 0, y: 0, w: 1, h: 1 }),
  straighten: z
    .number()
    .meta({ format: 'double' })
    .min(-45)
    .max(45)
    .default(0)
    .describe('Straighten angle in degrees, applied before the crop'),
  rotation: z
    .int()
    .min(0)
    .max(270)
    .default(0)
    .refine((value) => [0, 90, 180, 270].includes(value), {
      error: 'Rotation must be one of the following values: 0, 90, 180, 270',
    })
    .describe('Quarter-turn rotation in degrees, clockwise'),
  flipHorizontal: z.boolean().default(false).describe('Mirror left to right'),
  flipVertical: z.boolean().default(false).describe('Mirror top to bottom'),
  preset: AssetDevelopPresetSchema.default(AssetDevelopPreset.Original),
  presetStrength: z.int().min(0).max(100).default(100).describe('How much of the preset is applied, as a percentage'),
  masks: z
    .array(AssetDevelopMaskSchema)
    .max(ASSET_DEVELOP_MAX_MASKS)
    .default([])
    .refine((masks) => new Set(masks.map((mask) => mask.id)).size === masks.length, {
      error: 'Mask identifiers must be unique',
    })
    .describe('Selective adjustments, applied in order after the global develop'),
  cleanup: z
    .array(AssetDevelopCleanupSchema)
    .max(ASSET_DEVELOP_MAX_CLEANUP)
    .default([])
    .refine((ops) => new Set(ops.map((op) => op.id)).size === ops.length, {
      error: 'Clean Up identifiers must be unique',
    })
    .describe('FL-233: Clean Up operations, applied in order to the original before every other step'),
});

export const KnownAssetDevelopRecipeSchema = KnownAssetDevelopRecipeFields.refine(
  (recipe) => recipeStrokePoints(recipe) <= ASSET_DEVELOP_MAX_RECIPE_POINTS,
  { error: `A recipe may carry at most ${ASSET_DEVELOP_MAX_RECIPE_POINTS} stroke points in all` },
).meta({ id: 'KnownAssetDevelopRecipe' });

/** HDR revisions use a separate identity; historical v1 and darktable v2 are unchanged. */
const LegacyHdrAssetDevelopRecipeSchema = KnownAssetDevelopRecipeFields.extend({
  version: z.literal(3).meta({ type: 'integer', format: 'int32' }),
  renderer: z.literal('frameleaf-develop-hdr/1').default('frameleaf-develop-hdr/1'),
  hdr: z
    .strictObject({
      version: z.literal(1).meta({ type: 'integer', format: 'int32' }).default(1),
      intent: z.literal('preserve').default('preserve'),
      referenceWhite: z.literal(203).meta({ type: 'integer', format: 'int32' }).default(203),
      sdrToneMapper: z.literal('libultrahdr/2.0.2').default('libultrahdr/2.0.2'),
    })
    .prefault({}),
})
  .strict()
  .meta({ id: 'HdrAssetDevelopRecipe' });
const VersionFourHdrAssetDevelopRecipeSchema = LegacyHdrAssetDevelopRecipeSchema.extend({
  version: z.literal(4).meta({ type: 'integer', format: 'int32' }),
  renderer: z.literal('frameleaf-develop-hdr/2').default('frameleaf-develop-hdr/2'),
  hdr: z
    .strictObject({
      version: z.literal(2).meta({ type: 'integer', format: 'int32' }).default(2),
      intent: z.literal('preserve').default('preserve'),
      referenceWhite: z.literal(203).meta({ type: 'integer', format: 'int32' }).default(203),
      sdrToneMapper: z.literal('libultrahdr/2.0.2-frameleaf.2').default('libultrahdr/2.0.2-frameleaf.2'),
    })
    .prefault({}),
})
  .refine((recipe) => recipeStrokePoints(recipe) <= ASSET_DEVELOP_MAX_RECIPE_POINTS, {
    error: `A recipe may carry at most ${ASSET_DEVELOP_MAX_RECIPE_POINTS} stroke points in all`,
  })
  .meta({ id: 'HdrAssetDevelopRecipeV4' });
const CurrentHdrAssetDevelopRecipeSchema = LegacyHdrAssetDevelopRecipeSchema.extend({
  version: z.literal(5).meta({ type: 'integer', format: 'int32' }),
  renderer: z.literal('frameleaf-develop-hdr/3').default('frameleaf-develop-hdr/3'),
  hdr: z
    .strictObject({
      version: z.literal(3).meta({ type: 'integer', format: 'int32' }).default(3),
      intent: z.literal('preserve').default('preserve'),
      referenceWhite: z.literal(203).meta({ type: 'integer', format: 'int32' }).default(203),
      sdrToneMapper: z.literal('libultrahdr/2.0.2-frameleaf.3').default('libultrahdr/2.0.2-frameleaf.3'),
    })
    .prefault({}),
})
  .refine((recipe) => recipeStrokePoints(recipe) <= ASSET_DEVELOP_MAX_RECIPE_POINTS, {
    error: `A recipe may carry at most ${ASSET_DEVELOP_MAX_RECIPE_POINTS} stroke points in all`,
  })
  .meta({ id: 'HdrAssetDevelopRecipeV5' });
export const HdrAssetDevelopRecipeSchema = z.union([
  LegacyHdrAssetDevelopRecipeSchema.refine((recipe) => recipeStrokePoints(recipe) <= ASSET_DEVELOP_MAX_RECIPE_POINTS),
  VersionFourHdrAssetDevelopRecipeSchema,
  CurrentHdrAssetDevelopRecipeSchema,
]);
export type HdrAssetDevelopRecipe = z.infer<typeof HdrAssetDevelopRecipeSchema>;

/** Stored/wire envelope. Opaque JSON is retained; it is never a render instruction. */
const VersionOneEnvelopeSchema = z
  .object({
    ...Object.fromEntries(
      Object.entries(KnownAssetDevelopRecipeFields.shape).map(([key, schema]) => [
        key,
        (schema instanceof z.ZodDefault ? schema.unwrap() : schema).optional(),
      ]),
    ),
    version: z.literal(ASSET_DEVELOP_RECIPE_VERSION),
    crop: AssetDevelopCropSchema.loose().meta({ id: 'AssetDevelopCrop' }).optional(),
    masks: z.array(z.record(z.string(), z.unknown())).optional(),
    cleanup: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .loose()
  .superRefine((value, ctx) => {
    const masks = value.masks;
    const cleanup = value.cleanup;
    const known = KnownAssetDevelopRecipeSchema.safeParse({
      ...value,
      // FL-233: a future Clean Up method stays opaque, exactly like a future mask kind
      cleanup: Array.isArray(cleanup)
        ? cleanup.filter(
            (op) =>
              op &&
              typeof op === 'object' &&
              Object.values(AssetDevelopCleanupMethod).includes(op.method as AssetDevelopCleanupMethod),
          )
        : cleanup,
      masks: Array.isArray(masks)
        ? masks.filter(
            (mask) =>
              mask &&
              typeof mask === 'object' &&
              Object.values(AssetDevelopMaskKind).includes(mask.kind as AssetDevelopMaskKind),
          )
        : masks,
    });
    if (!known.success)
      for (const issue of known.error.issues)
        ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  });

export const AssetDevelopRecipeSchema = z
  .preprocess(
    (value, ctx) => {
      const error = recipeJsonError(value);
      if (error) ctx.addIssue({ code: 'custom', message: error });
      return value;
    },
    z.union([VersionOneEnvelopeSchema, z.object({ version: z.int().min(2).max(2_147_483_647) }).loose()]),
  )
  .pipe(z.object({ version: z.int().min(1).max(2_147_483_647) }).loose())
  .nonoptional()
  .meta({ id: 'AssetDevelopRecipeDto' });

/**
 * Shared envelope budget. FL-233 sized it so every recipe the known schema allows fits: 4096 stroke
 * points (three JSON values each) in up to 2560 strokes (four more each) need about 23,000 values
 * and, with full-precision coordinates, about 330 KiB of JSON. Strings and keys stay within 64 KiB.
 */
export const RECIPE_JSON_MAX_VALUES = 32_768;
export const RECIPE_JSON_MAX_BYTES = 512 * 1024;
export const RECIPE_JSON_MAX_TEXT_BYTES = 64 * 1024;

/** Envelope budget: `RECIPE_JSON_MAX_*`, depth 16, arrays of 4096, 128 keys per object. */
export function recipeJsonError(value: unknown): string | undefined {
  let count = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (++count > RECIPE_JSON_MAX_VALUES || depth > 16) return false;
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      if (typeof item === 'string' && item.length > RECIPE_JSON_MAX_TEXT_BYTES) return false;
      bytes += new TextEncoder().encode(JSON.stringify(item)).length;
      return bytes <= RECIPE_JSON_MAX_TEXT_BYTES;
    }
    if (typeof item === 'number') return Number.isFinite(item);
    if (Array.isArray(item)) return item.length <= 4096 && item.every((entry) => visit(entry, depth + 1));
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) return false;
    const entries = Object.entries(item);
    return (
      entries.length <= 128 &&
      entries.every(
        ([key, entry]) =>
          (bytes += new TextEncoder().encode(key).length) <= RECIPE_JSON_MAX_TEXT_BYTES &&
          key.length <= 128 &&
          !['__proto__', 'prototype', 'constructor'].includes(key) &&
          visit(entry, depth + 1),
      )
    );
  };
  if (!visit(value, 0)) return 'Recipe must be bounded plain JSON without unsafe keys';
  if (new TextEncoder().encode(JSON.stringify(value)).length > RECIPE_JSON_MAX_BYTES) return 'Recipe exceeds 512 KiB';
}

export type KnownAssetDevelopRecipe = z.infer<typeof KnownAssetDevelopRecipeSchema>;

export type AssetDevelopRecipe = z.infer<typeof AssetDevelopRecipeSchema>;
export type AssetDevelopCrop = z.infer<typeof AssetDevelopCropSchema>;
export type AssetDevelopMask = z.infer<typeof AssetDevelopMaskSchema>;
export type AssetDevelopMaskAdjustments = z.infer<typeof AssetDevelopMaskAdjustmentsSchema>;
export type AssetDevelopCleanup = z.infer<typeof AssetDevelopCleanupSchema>;

const AssetDevelopSaveSchema = z
  .object({
    recipe: AssetDevelopRecipeSchema,
    sourceRevisionId: z
      .uuidv4()
      .optional()
      .describe(
        'Immutable revision of this owned asset whose omitted fields are preserved; never the implicit current revision',
      ),
    replaceRecipe: z
      .boolean()
      .optional()
      .describe(
        'Explicit complete replacement instead of preserving omitted source fields, including intentional removals',
      ),
    label: z.string().trim().min(1).max(120).optional().describe('Optional name for the saved version'),
    render: z.boolean().default(true).describe('Queue the edited master render immediately after saving the recipe'),
  })
  .meta({ id: 'AssetDevelopSaveDto' });

const AssetDevelopPreviewSchema = z
  .object({
    recipe: AssetDevelopRecipeSchema,
    dynamicRange: z.enum(['auto', 'sdr', 'hdr']).optional().describe('Omitted requests retain SDR-compatible previews'),
    size: z
      .int()
      .min(256)
      .max(2048)
      .default(1280)
      .describe('Longest edge of the preview in pixels; the original is never upscaled'),
  })
  .meta({ id: 'AssetDevelopPreviewDto' });

const AssetDevelopRevertSchema = z
  .object({
    revisionId: z
      .uuidv4()
      .optional()
      .describe('Rendered revision to make current again; omitted, the original becomes current'),
  })
  .meta({ id: 'AssetDevelopRevertDto' });

const AssetDevelopFileQuerySchema = z
  .object({
    kind: AssetDevelopFileKindSchema.default(AssetDevelopFileKind.Preview),
    dynamicRange: z.enum(['auto', 'sdr', 'hdr']).optional(),
    format: z
      .enum(['sdr-jpeg', 'hdr-jpeg', 'hdr-heic'])
      .optional()
      .describe(
        'Explicit full-resolution still export. Overrides dynamicRange and requires download permission. Original downloads use the existing original endpoint; motion is never included in a still export.',
      ),
  })
  .meta({ id: 'AssetDevelopFileQueryDto' });

const AssetDevelopRevisionParamSchema = z
  .object({
    id: z.uuidv4().describe('Asset ID'),
    revisionId: z.uuidv4().describe('Develop revision ID'),
  })
  .meta({ id: 'AssetDevelopRevisionParamDto' });

const AssetDevelopRevisionResponseSchema = z
  .object({
    id: z.uuidv4().describe('Develop revision ID'),
    assetId: z.uuidv4().describe('Asset this revision belongs to'),
    revision: z.int().min(1).describe('Per-asset sequence number, 1 for the first saved version'),
    label: z.string().nullable().describe('Name given when the version was saved'),
    status: AssetDevelopRevisionStatusSchema,
    progress: z.int().min(0).max(100).describe('Render progress as a percentage'),
    error: z.string().nullable().describe('Why the last render failed, when it did'),
    recipe: AssetDevelopRecipeSchema,
    rendererVersion: z.string().nullable().describe('Identity of the renderer that produced the files, for lineage'),
    width: z.int().nullable().describe('Width of the edited master in pixels'),
    height: z.int().nullable().describe('Height of the edited master in pixels'),
    kind: AssetDevelopRevisionKindSchema,
    sourceChecksum: z
      .string()
      .nullable()
      .describe('SHA-256 (hex) of the original this version was rendered or developed from'),
    renditionChecksum: z.string().nullable().describe('SHA-256 (hex) of the edited master file, once it exists'),
    exportId: z.uuidv4().nullable().describe('The export of the original an imported version was developed from'),
    fileName: z.string().nullable().describe('Name of the imported file, for a version developed elsewhere'),
    software: z.string().nullable().describe('Application an imported version was developed with, when known'),
    attempts: z.int().min(0).describe('Render attempts so far; one automatic retry follows a first failure'),
    isCurrent: z.boolean().describe('True for the version the asset currently shows'),
    outputDynamicRange: z.enum(['hdr', 'sdr', 'unknown']).optional(),
    hdrRenderStatus: z.enum(['not-requested', 'pending', 'rendered', 'failed', 'disabled']).optional(),
    hasHdrMaster: z.boolean().optional(),
    hasHdrPreview: z.boolean().optional(),
    hasMaster: z.boolean().describe('True once the edited master file exists'),
    hasPreview: z.boolean().describe('True once the preview file exists'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the version was saved'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('When the revision last changed'),
    renderedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the render finished'),
  })
  .meta({ id: 'AssetDevelopRevisionResponseDto' });

const AssetDevelopResponseSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID these revisions belong to'),
    currentRevisionId: z
      .uuidv4()
      .nullable()
      .describe('The revision the asset currently shows; null means the original'),
    revisions: z.array(AssetDevelopRevisionResponseSchema).describe('Every saved version of the recipe, newest first'),
  })
  .meta({ id: 'AssetDevelopResponseDto' });

export enum AssetDevelopArtifactKind {
  /** A greyscale mask bitmap covering the whole original (subject, sky and background masks). */
  Mask = 'mask',
  /** An RGBA generated fill for a Clean Up remove operation, covering the operation's area. */
  Fill = 'fill',
}

export const AssetDevelopArtifactKindSchema = z
  .enum(AssetDevelopArtifactKind)
  .describe('What a develop artifact is used for')
  .meta({ id: 'AssetDevelopArtifactKind' });

const AssetDevelopArtifactUploadSchema = z
  .object({
    kind: AssetDevelopArtifactKindSchema,
    /**
     * Documents the multipart file part for the API docs and generated clients. File parts never
     * reach the request body; the controller hands the uploaded file to the service.
     */
    file: z
      .any()
      .optional()
      .describe('A PNG (or another still image the server can read): greyscale for a mask, with alpha for a fill')
      .meta({ type: 'string', format: 'binary', [ApiCustomExtension.Required]: true }),
  })
  .meta({ id: 'AssetDevelopArtifactUploadDto' });

const AssetDevelopArtifactResponseSchema = z
  .object({
    id: AssetDevelopArtifactIdSchema,
    kind: AssetDevelopArtifactKindSchema,
    width: z.int().min(1).describe('Width of the stored bitmap in pixels'),
    height: z.int().min(1).describe('Height of the stored bitmap in pixels'),
  })
  .meta({ id: 'AssetDevelopArtifactResponseDto' });

export class AssetDevelopArtifactUploadDto extends createZodDto(AssetDevelopArtifactUploadSchema) {}
export class AssetDevelopArtifactResponseDto extends createZodDto(AssetDevelopArtifactResponseSchema) {}
export class AssetDevelopRecipeDto extends createZodDto(AssetDevelopRecipeSchema) {}

/**
 * FL-233: the renderable version 1 recipe, field by field, published in the OpenAPI document for the
 * native apps (routes take and return the opaque envelope, `AssetDevelopRecipeDto`).
 */
@ExtraModel()
export class HdrAssetDevelopRecipeDto extends createZodDto(LegacyHdrAssetDevelopRecipeSchema) {}
@ExtraModel()
export class HdrAssetDevelopRecipeV4Dto extends createZodDto(VersionFourHdrAssetDevelopRecipeSchema) {}
@ExtraModel()
export class HdrAssetDevelopRecipeV5Dto extends createZodDto(CurrentHdrAssetDevelopRecipeSchema) {}
@ExtraModel()
export class KnownAssetDevelopRecipeDto extends createZodDto(KnownAssetDevelopRecipeSchema) {}
export class AssetDevelopSaveDto extends createZodDto(AssetDevelopSaveSchema) {}
export class AssetDevelopPreviewDto extends createZodDto(AssetDevelopPreviewSchema) {}
export class AssetDevelopRevertDto extends createZodDto(AssetDevelopRevertSchema) {}
export class AssetDevelopFileQueryDto extends createZodDto(AssetDevelopFileQuerySchema) {}
export class AssetDevelopRevisionParamDto extends createZodDto(AssetDevelopRevisionParamSchema) {}
export class AssetDevelopRevisionResponseDto extends createZodDto(AssetDevelopRevisionResponseSchema) {}
export class AssetDevelopResponseDto extends createZodDto(AssetDevelopResponseSchema) {}

export class AssetDevelopSemanticMaskDto extends createZodDto(z.strictObject({ target: z.enum(['subject', 'sky']) })) {}
