import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/**
 * The still-image edit recipe (FL-113). A recipe is the complete, versioned description of a
 * quick edit: develop sliders, the chosen look and its strength, and the geometry (crop,
 * straighten, quarter-turn rotation, flips). It is stored as a revision against the asset and
 * rendered by the server into an edited master plus a preview; the original is never touched.
 *
 * Ranges follow the design prototype's `develop.mjs` so the client and the renderer agree on
 * the meaning of every value. `version` is the contract version of the recipe shape itself.
 */
export const ASSET_DEVELOP_RECIPE_VERSION = 1;

export enum AssetDevelopPreset {
  Original = 'Original',
  Vivid = 'Vivid',
  Natural = 'Natural',
  Warm = 'Warm',
  Cool = 'Cool',
  Mono = 'Mono',
  Silvertone = 'Silvertone',
  Noir = 'Noir',
  Fade = 'Fade',
}

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
  .meta({ id: 'AssetDevelopCrop' });

export const AssetDevelopRecipeSchema = z
  .object({
    version: z.literal(ASSET_DEVELOP_RECIPE_VERSION).meta({ format: 'double' }).describe('Recipe contract version'),
    exposure: z
      .number()
      .meta({ format: 'double' })
      .min(-2)
      .max(2)
      .default(0)
      .describe('Exposure in EV; each whole stop doubles the light'),
    contrast: bipolar('Contrast around middle grey'),
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
  })
  .meta({ id: 'AssetDevelopRecipeDto' });

export type AssetDevelopRecipe = z.infer<typeof AssetDevelopRecipeSchema>;
export type AssetDevelopCrop = z.infer<typeof AssetDevelopCropSchema>;

const AssetDevelopSaveSchema = z
  .object({
    recipe: AssetDevelopRecipeSchema,
    label: z.string().trim().min(1).max(120).optional().describe('Optional name for the saved version'),
    render: z.boolean().default(true).describe('Queue the edited master render immediately after saving the recipe'),
  })
  .meta({ id: 'AssetDevelopSaveDto' });

const AssetDevelopPreviewSchema = z
  .object({
    recipe: AssetDevelopRecipeSchema,
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
    isCurrent: z.boolean().describe('True for the version the asset currently shows'),
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

export class AssetDevelopRecipeDto extends createZodDto(AssetDevelopRecipeSchema) {}
export class AssetDevelopSaveDto extends createZodDto(AssetDevelopSaveSchema) {}
export class AssetDevelopPreviewDto extends createZodDto(AssetDevelopPreviewSchema) {}
export class AssetDevelopRevertDto extends createZodDto(AssetDevelopRevertSchema) {}
export class AssetDevelopFileQueryDto extends createZodDto(AssetDevelopFileQuerySchema) {}
export class AssetDevelopRevisionParamDto extends createZodDto(AssetDevelopRevisionParamSchema) {}
export class AssetDevelopRevisionResponseDto extends createZodDto(AssetDevelopRevisionResponseSchema) {}
export class AssetDevelopResponseDto extends createZodDto(AssetDevelopResponseSchema) {}
