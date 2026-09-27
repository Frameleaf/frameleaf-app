import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetRestorationModeSchema, AssetRestorationSourceTypeSchema } from 'src/dtos/asset-restoration.dto.js';

/**
 * Why a restored version cannot be placed in Studio right now (FL-115). Only its owner ever sees one
 * of these; anyone else is told the restoration does not exist.
 */
export enum StudioRestoredVersionUnavailable {
  Discarded = 'discarded',
  Expired = 'expired',
  NotReady = 'not-ready',
  Locked = 'locked',
  Trashed = 'trashed',
  Offline = 'offline',
  HiddenContent = 'hidden-content',
}

const StudioRestoredVersionUnavailableSchema = z
  .enum(StudioRestoredVersionUnavailable)
  .describe('Why the restored version cannot be placed')
  .meta({ id: 'StudioRestoredVersionUnavailable' });

/**
 * An accepted AI restoration as an entry of the Studio media bin (FL-115). It is always its own
 * version: `mediaId` is what a clip of it carries in the project graph, and the original keeps its
 * own id and file.
 */
const StudioRestoredVersionSchema = z
  .object({
    restorationId: z.uuid().describe('The restoration'),
    assetId: z.uuid().describe('The library original it was made from; never replaced by it'),
    mediaId: z.string().describe('The media id a clip of this version carries: `restored-<restorationId>`'),
    available: z.boolean().describe('Whether it can be placed and rendered now'),
    unavailable: StudioRestoredVersionUnavailableSchema.nullable(),
    sourceType: AssetRestorationSourceTypeSchema,
    mode: AssetRestorationModeSchema,
    upscale: z.int().describe('Upscale factor of a restoration; 1 for Smooth motion'),
    smoothMotionFactor: z.int().nullable().describe('Frame-rate factor of a Smooth motion version'),
    width: z.int().nullable().describe('Pixel width of the restored file'),
    height: z.int().nullable().describe('Pixel height of the restored file'),
    durationSeconds: z.number().meta({ format: 'double' }).nullable().describe('Length of a video, in seconds'),
    originalFileName: z.string().describe('The original’s file name, for the bin label'),
    restoredAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the full result finished'),
    expiresAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the result will be removed, when it has a retention date'),
  })
  .meta({ id: 'StudioRestoredVersionDto' });

export class StudioRestoredVersionDto extends createZodDto(StudioRestoredVersionSchema) {}
