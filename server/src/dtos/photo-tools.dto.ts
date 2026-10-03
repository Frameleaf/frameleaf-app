import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import {
  ASSET_DEVELOP_MAX_MASKS,
  AssetDevelopMaskFields,
  AssetDevelopMaskKind,
  DarktableDevelopRecipeSchema,
  KnownAssetDevelopRecipeFields,
} from 'src/dtos/asset-develop.dto.js';
import { ApiCustomExtension } from 'src/enum.js';

/**
 * Selective photo tools (FL-64): reusable develop presets and the external development round
 * trip. The recipe contract, masks included, lives in `asset-develop.dto.ts`.
 */

/** The most presets one account keeps; a preset is a few hundred bytes, the cap only stops abuse. */
export const DEVELOP_PRESET_MAX = 200;

/** FL-233: a preset carries only the mask kinds that fit any photo (never brush or bitmap masks). */
const DevelopPresetMaskSchema = AssetDevelopMaskFields.omit({ strokes: true, artifact: true, detector: true })
  .extend({
    kind: z
      .enum([AssetDevelopMaskKind.Radial, AssetDevelopMaskKind.Linear])
      .describe('Shape of a selective adjustment mask')
      .meta({ id: 'DevelopPresetMaskKind' }),
  })
  .refine((mask) => mask.kind !== AssetDevelopMaskKind.Linear || mask.x !== mask.endX || mask.y !== mask.endY, {
    error: 'A linear mask needs different start and end points',
  })
  .meta({ id: 'DevelopPresetMask' });

const DevelopPresetMasksSchema = z
  .array(DevelopPresetMaskSchema)
  .max(ASSET_DEVELOP_MAX_MASKS)
  .refine((masks) => new Set(masks.map((mask) => mask.id)).size === masks.length, {
    error: 'Mask identifiers must be unique',
  })
  .describe('Radial and linear selective adjustments, applied in order after the global develop');

const DevelopPresetSettingsFields = KnownAssetDevelopRecipeFields.pick({
  exposure: true,
  contrast: true,
  brilliance: true,
  highlights: true,
  shadows: true,
  whites: true,
  blacks: true,
  temperature: true,
  tint: true,
  vibrance: true,
  saturation: true,
  clarity: true,
  dehaze: true,
  vignette: true,
  grain: true,
  sharpen: true,
  noiseReduction: true,
  preset: true,
  presetStrength: true,
});

/**
 * What a preset applies: every develop slider (Brilliance included, FL-233), the look and its
 * strength, and the radial and linear masks. Geometry (crop, straighten, turns, flips) is never part
 * of a preset, exactly like Copy and Paste adjustments, so applying one never reframes a photo; nor
 * are brush and subject/sky/background masks or Clean Up, which belong to one photo's content.
 * A new preset fills every setting it is not sent with its neutral value (no change).
 */
export const NativeDevelopPresetSchema = DarktableDevelopRecipeSchema.refine(
  (recipe) =>
    !recipe.crop &&
    !recipe.straighten &&
    !recipe.rotation &&
    !recipe.flipHorizontal &&
    !recipe.flipVertical &&
    !recipe.sensorCanvas &&
    (recipe.masks ?? []).every(
      (mask) => mask.kind === AssetDevelopMaskKind.Radial || mask.kind === AssetDevelopMaskKind.Linear,
    ),
  { error: 'Native presets carry adjustments and reusable shapes, never geometry or photo-specific masks' },
);

export const DevelopPresetSettingsSchema = DevelopPresetSettingsFields.extend({
  masks: DevelopPresetMasksSchema.default([]),
  native: NativeDevelopPresetSchema.optional(),
}).meta({ id: 'DevelopPresetSettingsDto' });

export type DevelopPresetSettings = z.infer<typeof DevelopPresetSettingsSchema>;

/**
 * FL-303: the settings of an update are a patch. A setting left out keeps its stored value instead
 * of falling back to neutral, so a client without a control (the web has no Brilliance) or older than
 * a field never resets it. `masks`, when sent, replaces every mask of the preset.
 */
const DevelopPresetSettingsUpdateSchema = z
  .object({
    ...Object.fromEntries(
      Object.entries(DevelopPresetSettingsFields.shape).map(([key, schema]) => {
        const optional = (schema instanceof z.ZodDefault ? schema.unwrap() : schema).optional();
        return [key, schema.description ? optional.describe(schema.description) : optional];
      }),
    ),
    masks: DevelopPresetMasksSchema.optional(),
    native: NativeDevelopPresetSchema.optional(),
  })
  .meta({ id: 'DevelopPresetSettingsUpdateDto' }) as unknown as z.ZodType<Partial<DevelopPresetSettings>>;

const presetName = z.string().trim().min(1).max(80).describe('Name shown in the presets list; unique per account');

const DevelopPresetCreateSchema = z
  .object({
    name: presetName,
    settings: DevelopPresetSettingsSchema.describe('Settings of the new preset; any left out take their neutral value'),
  })
  .meta({ id: 'DevelopPresetCreateDto' });

const DevelopPresetUpdateSchema = z
  .object({
    name: presetName.optional(),
    settings: DevelopPresetSettingsUpdateSchema.optional().describe(
      'Settings to change; every setting left out, including ones this client does not know, keeps its stored value',
    ),
  })
  .refine((value) => value.name !== undefined || value.settings !== undefined, {
    error: 'Change the name or the settings',
  })
  .meta({ id: 'DevelopPresetUpdateDto' });

const DevelopPresetResponseSchema = z
  .object({
    id: z.uuidv4().describe('Preset ID'),
    name: z.string().describe('Preset name'),
    settings: DevelopPresetSettingsSchema,
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the preset was saved'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('When the preset last changed'),
  })
  .meta({ id: 'DevelopPresetResponseDto' });

const sha256Hex = (description: string) =>
  z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[\da-f]{64}$/, { error: 'Expected a SHA-256 checksum as 64 hexadecimal characters' })
    .describe(description);

const DevelopExportResponseSchema = z
  .object({
    id: z.uuidv4().describe('Export ID; quote it when bringing the developed file back'),
    assetId: z.uuidv4().describe('Asset whose original was exported'),
    fileName: z.string().describe('File name of the exported original'),
    sourceChecksum: z.string().describe('SHA-256 (hex) of the original when it was exported'),
    isCurrentOriginal: z
      .boolean()
      .describe('False once the asset original no longer matches the exported bytes; a return is then refused'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the original was exported'),
  })
  .meta({ id: 'DevelopExportResponseDto' });

/**
 * The form fields sent with a developed file. The file itself is the multipart `file` part.
 * At least one of `exportId` and `sourceChecksum` names the original the file was made from.
 */
const AssetDevelopImportSchema = z
  .object({
    exportId: z.uuidv4().optional().describe('The export this file was developed from'),
    sourceChecksum: sha256Hex('SHA-256 (hex) of the original the file was developed from').optional(),
    renditionChecksum: sha256Hex(
      'SHA-256 (hex) of the file as the client sent it; a transfer that does not match is refused',
    ).optional(),
    software: z.string().trim().min(1).max(120).optional().describe('Application the file was developed with'),
    label: z.string().trim().min(1).max(120).optional().describe('Optional name for the new version'),
    /**
     * Documents the multipart file part for the API docs and generated clients. File parts never
     * reach the request body; the controller hands the uploaded file to the service.
     */
    file: z
      .any()
      .optional()
      .describe('The developed file: JPEG, PNG, TIFF, WebP or HEIF')
      .meta({ type: 'string', format: 'binary', [ApiCustomExtension.Required]: true }),
  })
  .refine((value) => value.exportId !== undefined || value.sourceChecksum !== undefined, {
    error: 'Say which export or original checksum the file was developed from',
  })
  .meta({ id: 'AssetDevelopImportDto' });

export class DevelopPresetCreateDto extends createZodDto(DevelopPresetCreateSchema) {}
export class DevelopPresetUpdateDto extends createZodDto(DevelopPresetUpdateSchema) {}
export class DevelopPresetResponseDto extends createZodDto(DevelopPresetResponseSchema) {}
export class DevelopExportResponseDto extends createZodDto(DevelopExportResponseSchema) {}
export class AssetDevelopImportDto extends createZodDto(AssetDevelopImportSchema) {}
