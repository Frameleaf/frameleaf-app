/**
 * Editing & playback (FL-366): the plain choices on Image previews and Video playback copies, and the
 * numbers each one writes. Every choice writes the settings the server already keeps (`image.*`,
 * `ffmpeg.*`); a server whose numbers match none of them is on its own numbers ("Custom"), which are
 * left alone until a choice replaces them. The same pattern as `work-presets.ts`.
 *
 * Preview quality (`image.thumbnail` and `image.preview`: size, format and quality):
 * - Balanced is the server's own default (`server/src/dtos/config.dto.ts`, `image`), so a server
 *   nobody has tuned reads "Balanced".
 * - Space saver and Sharpest are the approved prototype's (`settings-v2/care/playback.jsx`, `SIZES`).
 *
 * Playback quality (`ffmpeg.targetResolution`, `ffmpeg.crf`) follows the prototype's `ENCODER`; the
 * owner chose "Better (1080p)" as the default (10 Oct), and the server's default is 1080p. The encoder
 * speed (`ffmpeg.preset`) is not part of the choice: real-time playback uses it too, so it stays as
 * set, under Advanced. Which videos get a copy is
 * `ffmpeg.transcode`: Required ("only those that need one") or All; the other rules stay in Advanced.
 */
import { ImageFormat, TranscodePolicy } from '@frameleaf/sdk';

export type PreviewQuality = 'saver' | 'balanced' | 'sharp';
export const PREVIEW_QUALITIES: readonly PreviewQuality[] = ['saver', 'balanced', 'sharp'];

type ImageCopy = { format: ImageFormat; size: number; quality: number; progressive?: boolean };
type PreviewNumbers = { thumbnail: ImageCopy; preview: ImageCopy };

const PREVIEW_SETS: Record<PreviewQuality, PreviewNumbers> = {
  saver: {
    thumbnail: { format: ImageFormat.Webp, size: 200, quality: 70 },
    preview: { format: ImageFormat.Webp, size: 1080, quality: 70 },
  },
  balanced: {
    thumbnail: { format: ImageFormat.Webp, size: 250, quality: 80 },
    preview: { format: ImageFormat.Jpeg, size: 1440, quality: 80 },
  },
  sharp: {
    thumbnail: { format: ImageFormat.Webp, size: 480, quality: 90 },
    preview: { format: ImageFormat.Jpeg, size: 2160, quality: 90 },
  },
};

const sameCopy = (copy: ImageCopy, wanted: ImageCopy) =>
  copy.format === wanted.format && copy.size === wanted.size && copy.quality === wanted.quality;

/** The preview quality the thumbnail and preview numbers are, or undefined for "Custom". */
export const previewQualityOf = (image: PreviewNumbers): PreviewQuality | undefined =>
  PREVIEW_QUALITIES.find(
    (quality) =>
      sameCopy(image.thumbnail, PREVIEW_SETS[quality].thumbnail) &&
      sameCopy(image.preview, PREVIEW_SETS[quality].preview),
  );

const writeCopy = (copy: ImageCopy, wanted: ImageCopy) => {
  copy.format = wanted.format;
  copy.size = wanted.size;
  copy.quality = wanted.quality;
  // A WebP picture cannot load progressively; the old page cleared it the same way.
  if (wanted.format === ImageFormat.Webp) {
    copy.progressive = false;
  }
};

/** Writes a preview quality into the draft's thumbnail and preview numbers, and nothing else. */
export const applyPreviewQuality = (image: PreviewNumbers, quality: PreviewQuality) => {
  writeCopy(image.thumbnail, PREVIEW_SETS[quality].thumbnail);
  writeCopy(image.preview, PREVIEW_SETS[quality].preview);
};

export type PlaybackQuality = 'good' | 'better' | 'best';
export const PLAYBACK_QUALITIES: readonly PlaybackQuality[] = ['good', 'better', 'best'];

type EncoderNumbers = { targetResolution: string; crf: number };

const PLAYBACK_SETS: Record<PlaybackQuality, EncoderNumbers> = {
  good: { targetResolution: '720', crf: 23 },
  better: { targetResolution: '1080', crf: 23 },
  best: { targetResolution: '2160', crf: 20 },
};

/** The playback quality the size and quality number are, or undefined for "Custom". */
export const playbackQualityOf = (ffmpeg: EncoderNumbers): PlaybackQuality | undefined =>
  PLAYBACK_QUALITIES.find((quality) => {
    const wanted = PLAYBACK_SETS[quality];
    return ffmpeg.targetResolution === wanted.targetResolution && ffmpeg.crf === wanted.crf;
  });

/** Writes a playback quality into the draft's size and quality number, and nothing else. */
export const applyPlaybackQuality = (ffmpeg: EncoderNumbers, quality: PlaybackQuality) => {
  Object.assign(ffmpeg, PLAYBACK_SETS[quality]);
};

export type CopyRule = 'needed' | 'all';
export const COPY_RULES: readonly CopyRule[] = ['needed', 'all'];

const RULE_POLICY: Record<CopyRule, TranscodePolicy> = {
  needed: TranscodePolicy.Required,
  all: TranscodePolicy.All,
};

/** Which videos get a copy, or undefined when the rule is one of the detailed ones under Advanced. */
export const copyRuleOf = (policy: TranscodePolicy): CopyRule | undefined =>
  COPY_RULES.find((rule) => RULE_POLICY[rule] === policy);

export const policyOf = (rule: CopyRule) => RULE_POLICY[rule];
