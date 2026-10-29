import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { StudioProjectImportSchema } from 'src/dtos/studio-project-import.dto.js';
import { MediaOperationStatusSchema } from 'src/enum.js';

const Identifier = z.string().regex(/^[\w-]{1,128}$/);

/** What "Found in this clip" can list (FL-637). */
export const StudioVoiceNoiseSchema = z
  .enum(['wind', 'hum', 'background', 'echo'])
  .describe('Wind, hum and buzz, background noise or room echo')
  .meta({ id: 'StudioVoiceNoise' });
export const StudioVoiceStrengthSchema = z
  .enum(['light', 'standard', 'strong'])
  .describe("Light keeps the room's sound, Standard removes most noise, Strong leaves the voice only")
  .meta({ id: 'StudioVoiceStrength' });
const HumHz = z
  .union([z.literal(50), z.literal(60)])
  .nullable()
  .describe('The mains frequency of the hum found, or null');

export class StudioVoiceAnalysisCreateDto extends createZodDto(
  z
    .object({ clipId: Identifier.describe('An audio clip on the main timeline of the head revision') })
    .meta({ id: 'StudioVoiceAnalysisCreateDto' }),
) {}

export class StudioVoiceAnalysisDto extends createZodDto(
  z
    .object({
      clipId: Identifier,
      noises: z.array(StudioVoiceNoiseSchema).describe('What the quick analysis found; the person can change it'),
      humHz: HumHz,
    })
    .meta({ id: 'StudioVoiceAnalysisDto' }),
) {}

export class StudioVoiceCleanupCreateDto extends createZodDto(
  z
    .object({
      clipId: Identifier.describe('An audio clip on the main timeline of the head revision'),
      strength: StudioVoiceStrengthSchema,
      noises: z.array(StudioVoiceNoiseSchema).min(1).max(4).describe('What to remove'),
      humHz: HumHz.optional(),
    })
    .meta({ id: 'StudioVoiceCleanupCreateDto' }),
) {}

export class StudioVoiceCleanupParamDto extends createZodDto(
  z.object({ id: z.uuidv7(), voiceCleanupId: z.uuidv7() }),
) {}

export class StudioVoiceCleanupQueuedDto extends createZodDto(
  z
    .object({
      id: z.uuidv7().describe('The job id; follow it in Activity (`/media-operations/{id}`)'),
      status: MediaOperationStatusSchema,
    })
    .meta({ id: 'StudioVoiceCleanupQueuedDto' }),
) {}

export const StudioVoiceCleanupResultSchema = z
  .object({
    import: StudioProjectImportSchema.describe('The cleaned sound, kept with the project as an audio import'),
    strength: StudioVoiceStrengthSchema,
    noises: z.array(StudioVoiceNoiseSchema),
    humHz: HumHz,
    sourceStartSeconds: z
      .number()
      .min(0)
      .meta({ format: 'double' })
      .describe("Where in the cleaned sound the clip's window starts (the handle before it)"),
    durationSeconds: z.number().min(0).meta({ format: 'double' }).describe('How long the cleaned sound is'),
  })
  .meta({ id: 'StudioVoiceCleanupResultDto' });

export class StudioVoiceCleanupDto extends createZodDto(
  z
    .object({
      id: z.uuidv7(),
      projectId: z.uuidv7(),
      clipId: Identifier,
      revision: z.int().min(1).describe('The revision whose clip was cleaned'),
      status: MediaOperationStatusSchema,
      progress: z.number().min(0).max(100).meta({ format: 'double' }),
      error: z.string().nullable(),
      result: StudioVoiceCleanupResultSchema.nullable().describe('Present once the job has completed'),
    })
    .meta({ id: 'StudioVoiceCleanupDto' }),
) {}
