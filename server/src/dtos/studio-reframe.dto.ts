import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { StudioReframePointSchema } from 'src/dtos/studio-export.dto.js';

/**
 * FL-563: the automatic framing of each shot for a vertical or square export. Read-only; the project
 * is not changed.
 */
const StudioReframeShotSchema = z
  .object({
    clipId: z.string().describe('The video or still on the main timeline'),
    type: z.enum(['video', 'image']).describe('A video clip or a still').meta({ id: 'StudioReframeShotType' }),
    assetId: z.string().nullable().describe('The library asset it shows, when this session may read it'),
    from: z.int().min(0).describe('First frame of the shot on the main timeline'),
    durationInFrames: z.int().min(1).describe('Length of the shot in frames'),
    subject: z
      .enum(['face', 'none'])
      .describe('What the framing follows: faces found in the shot, or nothing found (centred)')
      .meta({ id: 'StudioReframeSubject' }),
    path: z
      .array(StudioReframePointSchema)
      .min(1)
      .describe('Where the subject is through the shot, as a share of the project frame width'),
  })
  .meta({ id: 'StudioReframeShotDto' });

const StudioReframeResponseSchema = z
  .object({
    revision: z.int().min(1).describe('The stored revision the framing was worked out for'),
    width: z.int().min(1).describe('Project frame width in pixels'),
    height: z.int().min(1).describe('Project frame height in pixels'),
    shots: z.array(StudioReframeShotSchema).describe('Every shot of the main timeline, in the order they start'),
  })
  .meta({ id: 'StudioReframeResponseDto' });

export class StudioReframeResponseDto extends createZodDto(StudioReframeResponseSchema) {}
