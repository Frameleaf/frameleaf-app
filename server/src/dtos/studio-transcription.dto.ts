import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationStatusSchema } from 'src/enum.js';

const Identifier = z.string().regex(/^[\w-]{1,128}$/);
const SafeInteger = z.int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const Seconds = z
  .object({ num: SafeInteger.min(0), den: SafeInteger.min(1) })
  .describe('Exact seconds on the main sequence, reduced')
  .meta({ id: 'StudioTranscriptionTime' });

export class StudioTranscriptionCreateDto extends createZodDto(
  z
    .object({
      clipId: Identifier.describe('A video or audio clip on the main timeline of the head revision'),
      language: z
        .string()
        .min(2)
        .max(35)
        .describe('A BCP 47 language tag such as `en` or `pt-BR`, or `auto` to detect the language'),
      destinationId: z.uuid().describe('The machine-learning destination to run on, named explicitly'),
    })
    .meta({ id: 'StudioTranscriptionCreateDto' }),
) {}

export class StudioTranscriptionParamDto extends createZodDto(
  z.object({ id: z.uuidv7(), transcriptionId: z.uuidv7() }),
) {}

export class StudioTranscriptionQueuedDto extends createZodDto(
  z
    .object({
      id: z.uuidv7().describe('The job id; follow it in Activity (`/media-operations/{id}`)'),
      status: MediaOperationStatusSchema,
    })
    .meta({ id: 'StudioTranscriptionQueuedDto' }),
) {}

const CueSchema = z.object({ start: Seconds, end: Seconds, text: z.string() }).meta({ id: 'StudioTranscriptionCue' });
const WordSchema = z
  .object({
    start: Seconds,
    end: Seconds,
    text: z.string(),
    cue: z.int().min(0).describe('Index of the cue the word belongs to'),
  })
  .meta({ id: 'StudioTranscriptionWord' });

export const StudioTranscriptionResultSchema = z
  .object({
    language: z.string().describe('The Whisper language code the speech was transcribed in'),
    languageProbability: z
      .number()
      .min(0)
      .max(1)
      .meta({ format: 'double' })
      .describe('How sure detection was; 1 when the language was given'),
    model: z.string().describe('The Whisper model the worker used'),
    cues: z.array(CueSchema).describe('Ready for `captions.set`: `{ start, end, text }` only'),
    words: z.array(WordSchema).describe('Word timings, for word-by-word caption styles'),
  })
  .meta({ id: 'StudioTranscriptionResultDto' });

export class StudioTranscriptionDto extends createZodDto(
  z
    .object({
      id: z.uuidv7(),
      projectId: z.uuidv7(),
      clipId: Identifier,
      revision: z.int().min(1).describe('The revision whose clip was transcribed'),
      language: z.string().describe('The language asked for (`auto` or a BCP 47 tag)'),
      destinationId: z.uuid(),
      status: MediaOperationStatusSchema,
      progress: z.number().min(0).max(100).meta({ format: 'double' }),
      error: z.string().nullable(),
      result: StudioTranscriptionResultSchema.nullable().describe('Present once the job has completed'),
    })
    .meta({ id: 'StudioTranscriptionDto' }),
) {}
