import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaOperationStatusSchema } from 'src/enum.js';
import { STUDIO_MOVIE_LENGTHS, STUDIO_MOVIE_MOODS } from 'src/utils/studio-movie.js';

export const StudioMovieMoodSchema = z
  .enum(STUDIO_MOVIE_MOODS)
  .describe('The mood of music made for the movie: Calm, Warm, Upbeat or Big moments')
  .meta({ id: 'StudioMovieMood' });

export const StudioMovieMusicKindSchema = z
  .enum(['generated', 'song'])
  .describe('`generated`: new music made for the movie; `song`: a song from the library')
  .meta({ id: 'StudioMovieMusicKind' });

export const StudioMovieSongKindSchema = z
  .enum(['audio', 'video'])
  .describe('An audio file, or a video whose soundtrack is used')
  .meta({ id: 'StudioMovieSongKind' });

export const StudioMovieStepSchema = z
  .enum(['moments', 'music', 'cuts', 'title', 'done'])
  .describe('What the job is doing: choosing moments, making or reading the music, cutting, adding the title')
  .meta({ id: 'StudioMovieStep' });

export class StudioMovieCreateDto extends createZodDto(
  z
    .object({
      albumId: z.uuid().optional().describe('Make the movie from this album'),
      memoryId: z.uuid().optional().describe('Make the movie from this memory'),
      assetIds: z.array(z.uuid()).min(1).max(2000).optional().describe('Make the movie from these photos and videos'),
      lengthSeconds: z
        .union(STUDIO_MOVIE_LENGTHS.map((length) => z.literal(length)))
        .describe('30, 60 or 180 seconds; a song shorter than this sets the length'),
      music: StudioMovieMusicKindSchema,
      mood: StudioMovieMoodSchema.optional().describe('For `generated` music'),
      songAssetId: z.uuid().optional().describe('For `song`: an audio file, or a video whose soundtrack is used'),
      title: z.string().max(80).optional().describe('The title at the start; defaults to the source name'),
      sourceName: z
        .string()
        .max(120)
        .optional()
        .describe('What the movie is made from, as the person sees it (the album or memory name)'),
      previousId: z
        .uuidv7()
        .optional()
        .describe(
          'Try another version: the earlier job. Its project gets the new cut as a new revision, so the current one stays in its history.',
        ),
    })
    .refine((dto) => [dto.albumId, dto.memoryId, dto.assetIds].filter(Boolean).length === 1, {
      message: 'Name exactly one of albumId, memoryId or assetIds',
    })
    .refine((dto) => (dto.music === 'generated' ? !!dto.mood : !!dto.songAssetId), {
      message: 'Generated music needs a mood; a song needs songAssetId',
    })
    .meta({ id: 'StudioMovieCreateDto' }),
) {}

export class StudioMovieQueuedDto extends createZodDto(
  z
    .object({
      id: z.uuidv7().describe('The job id; it also shows in Activity (`/media-operations/{id}`)'),
      status: MediaOperationStatusSchema,
    })
    .meta({ id: 'StudioMovieQueuedDto' }),
) {}

const ShotSchema = z
  .object({
    assetId: z.uuid(),
    start: z.number().min(0).meta({ format: 'double' }).describe('Seconds into the movie'),
    end: z.number().min(0).meta({ format: 'double' }),
  })
  .meta({ id: 'StudioMovieShot' });

export const StudioMovieResultSchema = z
  .object({
    projectId: z.uuidv7().describe('The Studio project the movie is saved in'),
    revision: z.int().min(1).describe('The project revision this version is'),
    version: z.int().min(1),
    title: z.string(),
    sourceName: z.string(),
    lengthSeconds: z.number().min(0).meta({ format: 'double' }),
    bpm: z.number().min(0).meta({ format: 'double' }),
    bars: z.array(z.number().meta({ format: 'double' })).describe('Bar starts, in seconds'),
    beats: z.array(z.number().meta({ format: 'double' })).describe('Every beat, in seconds'),
    downbeat: z.int().min(0).max(3).describe('Which of the first four beats starts a bar'),
    shots: z.array(ShotSchema),
    music: StudioMovieMusicKindSchema,
    mood: StudioMovieMoodSchema.nullable(),
    musicName: z.string().describe('The song name, or empty for music made for the movie'),
    musicImportId: z.uuid().describe('The music, kept with the project'),
    musicSeconds: z.number().min(0).meta({ format: 'double' }),
  })
  .meta({ id: 'StudioMovieResultDto' });
export type StudioMovieResult = z.infer<typeof StudioMovieResultSchema>;

export class StudioMovieDto extends createZodDto(
  z
    .object({
      id: z.uuidv7(),
      status: MediaOperationStatusSchema,
      step: StudioMovieStepSchema,
      progress: z.number().min(0).max(100).meta({ format: 'double' }),
      error: z.string().nullable(),
      result: StudioMovieResultSchema.nullable().describe('Present once the job has completed'),
    })
    .meta({ id: 'StudioMovieDto' }),
) {}

export class StudioMovieSongQueryDto extends createZodDto(
  z.object({ query: z.string().max(100).optional().describe('Part of the file name') }),
) {}

export class StudioMovieSongDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      kind: StudioMovieSongKindSchema,
      name: z.string(),
      durationSeconds: z.number().min(0).meta({ format: 'double' }),
    })
    .meta({ id: 'StudioMovieSongDto' }),
) {}
