import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { FILMSTRIP_COUNT, FILMSTRIP_HEIGHT, WAVEFORM_BUCKETS } from 'src/utils/studio-media.js';

const FilmstripFormatSchema = z
  .enum(['jpeg', 'webp'])
  .describe('Sprite sheet image format')
  .meta({ id: 'AssetFilmstripFormat' });

const AssetFilmstripOptionsSchema = z
  .object({
    count: z.coerce
      .number()
      .int()
      .min(FILMSTRIP_COUNT.min)
      .max(FILMSTRIP_COUNT.max)
      .default(FILMSTRIP_COUNT.default)
      .optional()
      .describe(`Frames to sample, evenly spaced along the video (default ${FILMSTRIP_COUNT.default})`),
    height: z.coerce
      .number()
      .int()
      .min(FILMSTRIP_HEIGHT.min)
      .max(FILMSTRIP_HEIGHT.max)
      .default(FILMSTRIP_HEIGHT.default)
      .optional()
      .describe(`Frame height in pixels (default ${FILMSTRIP_HEIGHT.default}); the width follows the aspect ratio`),
    format: FilmstripFormatSchema.default('jpeg').optional(),
  })
  .meta({ id: 'AssetFilmstripOptionsDto' });

const AssetFilmstripSpriteOptionsSchema = AssetFilmstripOptionsSchema.extend({
  version: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional()
    .describe('The `version` from the filmstrip index. When given and the video changed since, 404 is returned'),
}).meta({ id: 'AssetFilmstripSpriteOptionsDto' });

const AssetFilmstripFrameSchema = z
  .object({
    index: z.int().describe('Frame position, 0-based'),
    timeMs: z.int().describe('Timestamp of the frame in the video, in milliseconds'),
    x: z.int().describe('Left edge of the frame in the sprite, in pixels'),
    y: z.int().describe('Top edge of the frame in the sprite, in pixels'),
  })
  .meta({ id: 'AssetFilmstripFrameDto' });

const AssetFilmstripResponseSchema = z
  .object({
    assetId: z.uuidv4(),
    version: z.string().describe('Changes whenever the video changes; pass it to the sprite request'),
    durationMs: z.int().describe('Duration of the video, in milliseconds'),
    format: FilmstripFormatSchema,
    mimeType: z.string().describe('Content type of the sprite'),
    frameWidth: z.int().describe('Width of every frame tile, in pixels'),
    frameHeight: z.int().describe('Height of every frame tile, in pixels'),
    columns: z.int().describe('Tiles per sprite row'),
    rows: z.int().describe('Sprite rows'),
    spriteWidth: z.int().describe('Sprite width, in pixels'),
    spriteHeight: z.int().describe('Sprite height, in pixels'),
    frames: z.array(AssetFilmstripFrameSchema).describe('Frames in time order, left to right, top to bottom'),
  })
  .meta({ id: 'AssetFilmstripResponseDto' });

const WaveformChannelModeSchema = z
  .enum(['mono', 'all'])
  .describe('mono downmixes every channel into one; all returns each channel (up to 8)')
  .meta({ id: 'AssetWaveformChannelMode' });

const AssetWaveformOptionsSchema = z
  .object({
    buckets: z.coerce
      .number()
      .int()
      .min(WAVEFORM_BUCKETS.min)
      .max(WAVEFORM_BUCKETS.max)
      .default(WAVEFORM_BUCKETS.default)
      .optional()
      .describe(
        `Peak pairs to return per channel (default ${WAVEFORM_BUCKETS.default}); fewer are returned for very short audio`,
      ),
    channels: WaveformChannelModeSchema.default('mono').optional(),
  })
  .meta({ id: 'AssetWaveformOptionsDto' });

const AssetWaveformChannelSchema = z
  .object({
    min: z.array(z.number().meta({ format: 'double' })).describe('Lowest sample in each bucket, -1 to 1'),
    max: z.array(z.number().meta({ format: 'double' })).describe('Highest sample in each bucket, -1 to 1'),
  })
  .meta({ id: 'AssetWaveformChannelDto' });

const AssetWaveformResponseSchema = z
  .object({
    assetId: z.uuidv4(),
    version: z.string().describe('Changes whenever the video changes'),
    hasAudio: z.boolean().describe('false for a video without an audio track; channels is then empty'),
    durationMs: z.int().describe('Duration of the decoded audio, in milliseconds'),
    bucketCount: z.int().describe('Peak pairs per channel'),
    bucketDurationMs: z.number().meta({ format: 'double' }).describe('Audio time each bucket covers, in milliseconds'),
    channels: z.array(AssetWaveformChannelSchema).describe('One entry for mono, otherwise one per channel'),
  })
  .meta({ id: 'AssetWaveformResponseDto' });

export class AssetFilmstripOptionsDto extends createZodDto(AssetFilmstripOptionsSchema) {}
export class AssetFilmstripSpriteOptionsDto extends createZodDto(AssetFilmstripSpriteOptionsSchema) {}
export class AssetFilmstripResponseDto extends createZodDto(AssetFilmstripResponseSchema) {}
export class AssetWaveformOptionsDto extends createZodDto(AssetWaveformOptionsSchema) {}
export class AssetWaveformResponseDto extends createZodDto(AssetWaveformResponseSchema) {}
