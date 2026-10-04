import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { PhotographyWatermarkPresetSchema } from 'src/dtos/photography-rendition.dto.js';

export const SHOOT_STAGES = ['Imported', 'Selected', 'Edited', 'Proofing', 'Delivered'] as const;
export const SHOOT_TYPES = [
  'Family portrait',
  'Wedding',
  'Portrait',
  'Editorial',
  'Commercial',
  'Event',
  'Personal',
] as const;
const ShootSchema = z.strictObject({
  id: z.uuidv4(),
  albumId: z.uuidv4().nullable().describe('Owned source album; null retains an unavailable existing shoot'),
  name: z.string().trim().min(1).max(200),
  client: z.string().trim().min(1).max(200),
  type: z.enum(SHOOT_TYPES),
  date: z.iso.date(),
  stage: z.enum(SHOOT_STAGES),
});
export type StoredShoot = Omit<z.infer<typeof ShootSchema>, 'albumId'> & { albumId: string };
export class PhotographyWorkspaceSaveDto extends createZodDto(
  z.strictObject({
    expectedRevision: z.uuid().nullable(),
    shoots: z
      .array(ShootSchema)
      .max(200)
      .refine((shoots) => new Set(shoots.map(({ id }) => id)).size === shoots.length, 'Duplicate shoot IDs'),
  }),
) {}
export class PhotographyWorkspaceDto extends createZodDto(
  z.object({
    revision: z.uuid().nullable(),
    shoots: z.array(
      ShootSchema.extend({
        unavailable: z.boolean(),
        coverAssetId: z.uuidv4().nullable(),
        assetCount: z.int().nonnegative().nullable(),
      }),
    ),
  }),
) {}
export class PhotographyPhotoQueryDto extends createZodDto(
  z.object({ cursor: z.string().min(1).max(500).optional() }),
) {}
export class PhotographyRatingDto extends createZodDto(
  z.strictObject({
    assetId: z.uuidv4(),
    rating: z
      .int()
      .min(-1)
      .max(5)
      .nullable()
      .refine((rating) => rating !== 0, 'Use null for unrated'),
  }),
) {}
export class PhotographyPhotosDto extends createZodDto(
  z.object({
    nextCursor: z.string().nullable(),
    photos: z.array(
      z.object({
        id: z.uuidv4(),
        fileName: z.string(),
        rating: z.int().min(-1).max(5).nullable(),
        canRate: z.boolean(),
        stackCount: z.int().nonnegative(),
        currentRevisionId: z.uuidv4().nullable(),
        camera: z.string(),
        capturedAt: z.string().nullable(),
        isRaw: z.boolean(),
        stackId: z.uuidv4().nullable(),
        width: z.int().nullable(),
        height: z.int().nullable(),
        eligible: z.boolean(),
        exclusion: z.string().nullable(),
        processing: z.enum(['ready', 'pending', 'failed']),
      }),
    ),
  }),
) {}

const BrandColorSchema = z.string().regex(/^#[\da-fA-F]{6}$/, 'Use a six-digit hexadecimal colour');
export const PhotographyBrandSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  tagline: z.string().trim().max(300),
  email: z.union([z.email().max(254), z.literal('')]),
  phone: z.string().trim().max(100),
  logoInitials: z.string().trim().max(12),
  logoAssetId: z.uuidv4().nullable(),
  color: BrandColorSchema,
  background: BrandColorSchema,
  textColor: BrandColorSchema,
  font: z.enum(['editorial', 'modern', 'classic']),
  watermarkColor: BrandColorSchema,
  watermarkOpacity: z.int().min(10).max(100),
  watermarkPosition: z.enum(['bottom-right', 'bottom-left', 'center', 'top-right']),
  watermarkSize: z.int().min(3).max(12),
  watermarkPresets: z.array(PhotographyWatermarkPresetSchema).max(30).default([]),
  webWatermarkPresetId: z.uuidv4().nullable().default(null),
  proofWatermarkPresetId: z.uuidv4().nullable().default(null),
  exportWatermarkPresetId: z.uuidv4().nullable().default(null),
});
export type PhotographyBrand = z.infer<typeof PhotographyBrandSchema>;
export class PhotographyBrandSaveDto extends createZodDto(
  z.strictObject({
    expectedRevision: z.uuid().nullable(),
    brand: PhotographyBrandSchema.omit({ logoAssetId: true }).extend({
      watermarkPresets: PhotographyBrandSchema.shape.watermarkPresets.removeDefault().optional(),
      webWatermarkPresetId: PhotographyBrandSchema.shape.webWatermarkPresetId.removeDefault().optional(),
      proofWatermarkPresetId: PhotographyBrandSchema.shape.proofWatermarkPresetId.removeDefault().optional(),
      exportWatermarkPresetId: PhotographyBrandSchema.shape.exportWatermarkPresetId.removeDefault().optional(),
      logoAssetId: z
        .uuidv4()
        .nullable()
        .optional()
        .describe('Omit to retain the existing logo reference; null explicitly selects initials'),
    }),
  }),
) {}
export class PhotographyBrandDto extends createZodDto(
  z.object({
    revision: z.uuid().nullable(),
    brand: PhotographyBrandSchema,
    logoUnavailable: z.boolean().describe('Stored logo is no longer eligible; its identity is redacted'),
  }),
) {}
export class PhotographyLogoCandidatesDto extends createZodDto(
  z.object({
    nextCursor: z.string().nullable(),
    logos: z.array(z.object({ id: z.uuidv4(), fileName: z.string() })),
  }),
) {}
