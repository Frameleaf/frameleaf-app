import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { TranscodeHardwareAccelerationSchema } from 'src/enum.js';
import { PLAYBACK_SELF_TEST_CASES } from 'src/utils/playback-self-test.js';

/**
 * FL-977: the video playback self-test. `none` until it has run once; `running` while it converts the
 * sample videos; `done` when each kind was checked; `failed` when the check could not finish.
 */
export const PLAYBACK_SELF_TEST_STATUSES = ['none', 'running', 'done', 'failed'] as const;

const PlaybackSelfTestStatusSchema = z
  .enum(PLAYBACK_SELF_TEST_STATUSES)
  .describe('Where the latest check is: none before the first, running, done, or failed when it could not finish')
  .meta({ id: 'PlaybackSelfTestStatus' });

export const PlaybackSelfTestCaseIdSchema = z
  .enum(PLAYBACK_SELF_TEST_CASES)
  .describe('A kind of video the playback self-test checks')
  .meta({ id: 'PlaybackSelfTestCase' });

const dateTime = () => z.string().meta({ format: 'date-time' });

const PlaybackSelfTestCaseSchema = z
  .object({
    id: PlaybackSelfTestCaseIdSchema,
    passed: z.boolean().describe('Whether the copy came out right'),
    problems: z
      .array(z.string())
      .describe(
        'What was wrong: convert-failed, codec, codec-tag, colour-tags, too-dark, too-bright or brightness-differs',
      ),
    hardware: z.boolean().describe('Whether the copy was made with hardware acceleration'),
    meanLuma: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('How bright the copy is: mean Rec. 709 luma, 0 to 255'),
    referenceMeanLuma: z
      .number()
      .meta({ format: 'double' })
      .nullable()
      .describe('How bright the same clip is when converted without hardware acceleration'),
    codecTag: z.string().nullable().describe('The sample-entry tag of the copy, for example hvc1'),
    colorTransfer: z.string().nullable().describe('The transfer characteristics the copy is tagged with'),
  })
  .meta({ id: 'PlaybackSelfTestCaseDto' });

const PlaybackSelfTestResponseSchema = z
  .object({
    status: PlaybackSelfTestStatusSchema,
    startedAt: dateTime().nullable().describe('When the latest check started'),
    finishedAt: dateTime().nullable().describe('When it finished'),
    accel: TranscodeHardwareAccelerationSchema.nullable().describe('The hardware acceleration it checked'),
    cases: z.array(PlaybackSelfTestCaseSchema).describe('Each kind of video, in the order it was checked'),
    softwareFallback: z
      .array(PlaybackSelfTestCaseIdSchema)
      .describe('The kinds now converted without hardware acceleration because the check found them wrong'),
  })
  .meta({ id: 'PlaybackSelfTestResponseDto' });

export class PlaybackSelfTestResponseDto extends createZodDto(PlaybackSelfTestResponseSchema) {}
