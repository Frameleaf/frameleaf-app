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

/**
 * FL-521: roughly how much a copy weighs against another: its pixels, its quality number and its format
 * (WebP is about a quarter smaller than JPEG at the same quality). Only ever used as a ratio.
 */
const copyWeight = (copy: ImageCopy) =>
  copy.size ** 2 * (copy.quality / 80) * (copy.format === ImageFormat.Webp ? 0.75 : 1);
const setWeight = (numbers: PreviewNumbers) => copyWeight(numbers.preview) + copyWeight(numbers.thumbnail);

/**
 * FL-521: about how much space previews would take with a choice, from the space they take now with the
 * saved numbers. "About": the real size depends on the photos.
 */
export const previewSpaceFor = (bytes: number, saved: PreviewNumbers, quality: PreviewQuality) =>
  Math.round((bytes * setWeight(PREVIEW_SETS[quality])) / setWeight(saved));

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

/**
 * FL-537: about how much a minute of playback copy takes at each quality, in MB: the prototype's
 * figures (`PLAYBACK`), which hold for a typical phone video.
 */
export const TYPICAL_MB_PER_MINUTE: Record<PlaybackQuality, number> = { good: 30, better: 60, best: 250 };

const roundMegabytes = (value: number) => (value >= 100 ? Math.round(value / 10) * 10 : Math.max(1, Math.round(value)));

/**
 * FL-537: "about N MB a minute" for each quality. Once the copies this server made have been measured
 * (their space over the length of the videos that have one), the saved quality says what they really
 * take and the others are scaled from it; until then the typical figures are said.
 */
export const megabytesPerMinute = (
  saved: PlaybackQuality | undefined,
  measured: { bytes: number | null; minutes: number } | undefined,
): Record<PlaybackQuality, number> => {
  const scale =
    saved && measured?.bytes && measured.minutes >= 1
      ? measured.bytes / 1_000_000 / measured.minutes / TYPICAL_MB_PER_MINUTE[saved]
      : 1;
  return {
    good: roundMegabytes(TYPICAL_MB_PER_MINUTE.good * scale),
    better: roundMegabytes(TYPICAL_MB_PER_MINUTE.better * scale),
    best: roundMegabytes(TYPICAL_MB_PER_MINUTE.best * scale),
  };
};
