import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetDevelopRecipeSchema } from 'src/dtos/asset-develop.dto.js';
import { ApiCustomExtension } from 'src/enum.js';

/**
 * Selective photo tools (FL-64): reusable develop presets and the external development round
 * trip. The recipe contract, masks included, lives in `asset-develop.dto.ts`.
 */

/** The most presets one account keeps; a preset is a few hundred bytes, the cap only stops abuse. */
export const DEVELOP_PRESET_MAX = 200;

/**
 * What a preset applies: every develop slider, the look and its strength, and the selective
 * masks. Geometry (crop, straighten, turns, flips) is never part of a preset, exactly like Copy
 * and Paste adjustments, so applying one never reframes a photo.
 */
export const DevelopPresetSettingsSchema = AssetDevelopRecipeSchema.pick({
  exposure: true,
  contrast: true,
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
  masks: true,
}).meta({ id: 'DevelopPresetSettingsDto' });

export type DevelopPresetSettings = z.infer<typeof DevelopPresetSettingsSchema>;

const presetName = z.string().trim().min(1).max(80).describe('Name shown in the presets list; unique per account');

const DevelopPresetCreateSchema = z
  .object({ name: presetName, settings: DevelopPresetSettingsSchema })
  .meta({ id: 'DevelopPresetCreateDto' });

const DevelopPresetUpdateSchema = z
  .object({
    name: presetName.optional(),
    settings: DevelopPresetSettingsSchema.optional().describe('Replaces every stored setting of the preset'),
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
