import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const coordinate = z.number().min(0).max(1_000_000).meta({ format: 'double' });

export const ScanSplitPointSchema = z
  .object({
    x: coordinate.describe('Pixels from the left edge of the scan as it is displayed'),
    y: coordinate.describe('Pixels from the top edge of the scan as it is displayed'),
  })
  .meta({ id: 'ScanSplitPointDto' });

const quad = z
  .array(ScanSplitPointSchema)
  .length(4)
  .describe("The print's corners on the scan: top-left, top-right, bottom-right, bottom-left");

// An integer, not an enum: the values are fixed by geometry, and clients need no decoder for them.
const rotation = z
  .int()
  .min(0)
  .max(270)
  .multipleOf(90)
  .describe('Degrees to turn the straightened print clockwise so it is upright: 0, 90, 180 or 270');

export const ScanSplitPrintSchema = z
  .object({
    quad,
    rotation,
    confidence: z
      .number()
      .min(0)
      .max(1)
      .meta({ format: 'double' })
      .describe('How sure the detection is that this is one whole print, from 0 to 1'),
  })
  .meta({ id: 'ScanSplitPrintDto' });

export const ScanSplitDetectResponseSchema = z
  .object({
    width: z.int().min(1).describe('Width of the scan as it is displayed, in pixels: the space the corners are in'),
    height: z.int().min(1).describe('Height of the scan as it is displayed, in pixels'),
    prints: z.array(ScanSplitPrintSchema).describe('The prints found, in reading order. Nothing is saved.'),
  })
  .meta({ id: 'ScanSplitDetectResponseDto' });

export const ScanSplitCropSchema = z.object({ quad, rotation: rotation.default(0) }).meta({ id: 'ScanSplitCropDto' });

export const ScanSplitSchema = z
  .object({
    crops: z.array(ScanSplitCropSchema).min(1).max(50).describe('The prints to cut out, as confirmed by the owner'),
  })
  .meta({ id: 'ScanSplitDto' });

export const ScanSplitExistingCropSchema = z
  .object({
    assetId: z.uuidv4().describe('The photo cut from this scan'),
    quad,
    rotation,
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the photo was cut out'),
    edited: z.boolean().describe('The owner has worked on this photo, so splitting again keeps it'),
  })
  .meta({ id: 'ScanSplitExistingCropDto' });

export const ScanSplitInfoResponseSchema = z
  .object({
    width: z.int().min(1).nullable().describe('Width of the scan as it is displayed, when its metadata has been read'),
    height: z
      .int()
      .min(1)
      .nullable()
      .describe('Height of the scan as it is displayed, when its metadata has been read'),
    crops: z.array(ScanSplitExistingCropSchema).describe('Photos cut from this scan that can be shown here'),
    cropCount: z.int().min(0).describe('All photos cut from this scan and not in the trash, shown here or not'),
    editedCount: z.int().min(0).describe('How many of cropCount are kept if the scan is split again'),
    sourceAssetId: z.uuidv4().nullable().describe('The scan this photo was cut from, when it can be shown'),
    sourceFileName: z.string().nullable().describe('The file name of that scan'),
  })
  .meta({ id: 'ScanSplitInfoResponseDto' });

export const ScanSplitOfferResponseSchema = z
  .object({
    printCount: z.int().min(0).describe('Prints found on an upload to an album that holds scans; 0 means no offer'),
    inScanAlbum: z.boolean().describe('Whether this photo is in an album marked as holding scans'),
  })
  .meta({ id: 'ScanSplitOfferResponseDto' });

export class ScanSplitDetectResponseDto extends createZodDto(ScanSplitDetectResponseSchema) {}
export class ScanSplitDto extends createZodDto(ScanSplitSchema) {}
export class ScanSplitInfoResponseDto extends createZodDto(ScanSplitInfoResponseSchema) {}
export class ScanSplitOfferResponseDto extends createZodDto(ScanSplitOfferResponseSchema) {}
