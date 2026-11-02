import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { QueueName } from 'src/enum.js';

/** FL-521: the reading features whose progress Library care shows. */
export const LIBRARY_PROGRESS_FEATURES = ['search', 'faces', 'text', 'captions', 'locked'] as const;
export type LibraryProgressFeature = (typeof LIBRARY_PROGRESS_FEATURES)[number];

const LibraryFeatureProgressSchema = z
  .object({
    feature: z
      .enum(LIBRARY_PROGRESS_FEATURES)
      .describe(
        'search: Visual search; faces: Faces; text: Text in photos; captions: Descriptions; locked: Locked detection',
      )
      .meta({ id: 'LibraryProgressFeature' }),
    done: z.int().nonnegative().describe('Photos and videos this feature has read'),
    total: z.int().nonnegative().describe('Photos and videos this feature reads'),
    perHour: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Photos read an hour lately, or null until it has been measured'),
    secondsLeft: z
      .int()
      .nonnegative()
      .nullable()
      .describe('About how long the rest takes at that rate, or null when not known'),
  })
  .meta({ id: 'LibraryFeatureProgressDto' });

const LibraryProgressResponseSchema = z
  .object({
    features: z.array(LibraryFeatureProgressSchema),
    measuredSince: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('The start of the period the rate is measured over'),
  })
  .meta({ id: 'LibraryProgressResponseDto' });

/** FL-521: the queues "Save and …" may start again over every photo, now or tonight. */
export const REDO_QUEUES = [
  QueueName.SmartSearch,
  QueueName.FacialRecognition,
  QueueName.ThumbnailGeneration,
  QueueName.VideoConversion,
] as const;

const LibraryRedoQueueSchema = z
  .enum(REDO_QUEUES)
  .describe(
    'smartSearch: read again for Visual search; facialRecognition: group faces again; thumbnailGeneration: rebuild previews; videoConversion: remake playback copies',
  )
  .meta({ id: 'LibraryRedoQueue' });

const LibraryRedoSchema = z
  .object({
    queue: LibraryRedoQueueSchema,
    when: z
      .enum(['now', 'tonight'])
      .describe('now: start over every photo now; tonight: in the next overnight run')
      .meta({ id: 'LibraryRedoWhen' }),
  })
  .meta({ id: 'LibraryRedoDto' });

const LibraryRedoResponseSchema = z
  .object({
    tonight: z.array(LibraryRedoQueueSchema).describe('Work waiting for the next overnight run'),
  })
  .meta({ id: 'LibraryRedoResponseDto' });

/** FL-537: the last "Test it" of the graphics card the video converter uses. */
const VideoCardTestSchema = z
  .object({
    at: z.string().meta({ format: 'date-time' }).describe('When it was tested'),
    ok: z.boolean().describe('The card made the test video'),
    encoder: z.string().nullable().describe('The encoder tested, or null when no graphics card was found'),
    speed: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Seconds of test video the card made a second, or null when it failed'),
    softwareSpeed: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('Seconds of test video the processor made a second, for comparison'),
    error: z.string().nullable().describe('Why the card failed, as the converter said it'),
  })
  .meta({ id: 'VideoCardTestDto' });

const VideoCardSchema = z
  .object({
    failedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the graphics card stopped helping (copies made on the processor), or null while it works'),
    slowdown: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe(
        'About how many times slower the processor makes copies than the card, from the last test that measured both',
      ),
    lastTest: VideoCardTestSchema.nullable(),
  })
  .meta({ id: 'VideoCardDto' });

/** FL-521: what the copies beside the originals take, for Editing & playback. */
const MediaCopiesResponseSchema = z
  .object({
    photos: z.int().nonnegative(),
    withoutPreview: z.int().nonnegative().describe('Photos and videos without a preview yet'),
    videos: z.int().nonnegative(),
    withCopy: z.int().nonnegative().describe('Videos with a playback copy'),
    previewsBytes: z.int().nonnegative().nullable().describe('Space thumbnails and previews take, when measured'),
    playbackBytes: z.int().nonnegative().nullable().describe('Space playback copies take, when measured'),
    measuredAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the space was last measured'),
    tonight: z.array(LibraryRedoQueueSchema).describe('Work waiting for the next overnight run'),
    videoMinutes: z
      .number()
      .meta({ format: 'double' })
      .nonnegative()
      .describe('FL-537: the length of every video, in minutes'),
    copyMinutes: z
      .number()
      .meta({ format: 'double' })
      .nonnegative()
      .describe('FL-537: the length of the videos with a playback copy, in minutes'),
    videoCard: VideoCardSchema,
  })
  .meta({ id: 'MediaCopiesResponseDto' });

export class LibraryProgressResponseDto extends createZodDto(LibraryProgressResponseSchema) {}
export class LibraryRedoDto extends createZodDto(LibraryRedoSchema) {}
export class LibraryRedoResponseDto extends createZodDto(LibraryRedoResponseSchema) {}
export class MediaCopiesResponseDto extends createZodDto(MediaCopiesResponseSchema) {}
export class VideoCardDto extends createZodDto(VideoCardSchema) {}
