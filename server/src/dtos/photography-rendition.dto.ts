import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const PhotographyWatermarkSchema = z.strictObject({
  type: z.enum(['text', 'logo', 'both']).default('text'),
  text: z.string().trim().min(1).max(200),
  secondLine: z.string().trim().max(200).default(''),
  font: z.enum(['script', 'serif', 'sans']).default('script'),
  pattern: z.enum(['signature', 'centre', 'diagonal', 'tile']).default('signature'),
  position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']).default('bottom-right'),
  logoPosition: z.enum(['above', 'below', 'left', 'right']).default('above'),
  alignment: z.enum(['left', 'center', 'right']).default('center'),
  size: z.number().min(1).max(30).default(6),
  logoScale: z.number().min(0.25).max(4).default(1),
  color: z
    .string()
    .regex(/^#[\da-fA-F]{6}$/)
    .default('#ffffff'),
  opacity: z.number().min(1).max(100).default(45),
  rotation: z.number().min(-180).max(180).default(0),
  margin: z.number().min(0).max(25).default(4),
  spacing: z.number().min(0).max(100).default(6),
  outline: z.boolean().default(false),
  backing: z.boolean().default(false),
  logoVariant: z.enum(['original', 'light', 'dark']).default('original'),
  logoAssetId: z.uuidv4().nullable().default(null),
});
export type PhotographyWatermark = z.infer<typeof PhotographyWatermarkSchema>;
export const PhotographyWatermarkPresetSchema = z.strictObject({
  id: z.uuidv4(),
  name: z.string().trim().min(1).max(100),
  version: z.int().positive(),
  watermark: PhotographyWatermarkSchema,
});
export type PhotographyWatermarkPreset = z.infer<typeof PhotographyWatermarkPresetSchema>;

export class PhotographyRenditionPreviewDto extends createZodDto(
  z.strictObject({
    watermark: PhotographyWatermarkSchema,
    orientation: z.enum(['portrait', 'landscape']).default('landscape'),
    background: z.enum(['light', 'dark']).default('dark'),
  }),
) {}
export class PhotographyLogoVariantDto extends createZodDto(
  z.object({ variant: z.enum(['original', 'light', 'dark']).default('original') }),
) {}
