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

export class ScanSplitDetectResponseDto extends createZodDto(ScanSplitDetectResponseSchema) {}
export class ScanSplitDto extends createZodDto(ScanSplitSchema) {}
