import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationStatusSchema } from 'src/enum.js';

const Identifier = z.string().regex(/^[\w-]{1,128}$/);
const Base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);

export class StudioStabiliseCreateDto extends createZodDto(
  z
    .object({
      clipId: Identifier.describe('A video clip on the main timeline of the head revision'),
    })
    .meta({ id: 'StudioStabiliseCreateDto' }),
) {}

export class StudioStabiliseParamDto extends createZodDto(z.object({ id: z.uuidv7(), stabiliseId: z.uuidv7() })) {}

export class StudioStabiliseQueuedDto extends createZodDto(
  z
    .object({
      id: z.uuidv7().describe('The job id; follow it in Activity (`/media-operations/{id}`)'),
      status: MediaOperationStatusSchema,
    })
    .meta({ id: 'StudioStabiliseQueuedDto' }),
) {}

export const StudioStabiliseMotionSchema = z
  .object({
    version: z.int().min(1).describe('Format version of the path; 1'),
    method: z.string().describe('How the movement was estimated, such as `block-similarity-v1`'),
    rate: z.number().gt(0).max(30).meta({ format: 'double' }).describe('Samples a second'),
    start: z.number().min(0).meta({ format: 'double' }).describe('Source seconds of the first sample'),
    count: z.int().min(1).describe('Samples in each path'),
    width: z.int().min(1).describe('Width of the analysed picture'),
    height: z.int().min(1).describe('Height of the analysed picture'),
    x: Base64.describe(
      'Cumulative horizontal camera path, fractions of the frame width, float32 little-endian, base64',
    ),
    y: Base64.describe('Cumulative vertical camera path, fractions of the frame height, float32 little-endian, base64'),
    a: Base64.describe('Cumulative camera turn in radians, float32 little-endian, base64'),
    found: z.number().min(0).max(1).meta({ format: 'double' }).describe('Share of frames whose movement was found'),
  })
  .meta({ id: 'StudioStabiliseMotionDto' });

export class StudioStabiliseDto extends createZodDto(
  z
    .object({
      id: z.uuidv7(),
      projectId: z.uuidv7(),
      clipId: Identifier,
      revision: z.int().min(1).describe('The revision whose clip was analysed'),
      status: MediaOperationStatusSchema,
      progress: z.number().min(0).max(100).meta({ format: 'double' }),
      error: z.string().nullable(),
      result: StudioStabiliseMotionSchema.nullable().describe(
        "Present once the job has completed: the clip's camera path, for its `stabilisation.motion`",
      ),
    })
    .meta({ id: 'StudioStabiliseDto' }),
) {}
