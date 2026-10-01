import { createZodDto } from 'nestjs-zod';
import z from 'zod';

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
      }),
    ),
  }),
) {}
