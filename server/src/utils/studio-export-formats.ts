/**
 * FL-105 / FL-408: every Studio export format, the stream it must contain and who can write it.
 *
 * One table so admission (`render-admission.ts`), the output contract (`studio-export-contract.ts`),
 * the capability snapshot and publication agree on the same container × codec matrix.
 *
 * - `writers` are exact encoder identities a worker reports: ffmpeg encoder names, or the measured
 *   browser WebCodecs AVC writer. A decoder name proves nothing, so matching is exact.
 * - `container` is the container token a worker's evidence names (`mp4`, `webm`, `mov`, `mkv`, …).
 * - `combination` formats were added with the FL-105 matrix. A worker must also advertise the format
 *   id itself, so evidence for a codec and a container measured separately never stands in for a
 *   combination the worker has not written. The original five formats keep their original rule.
 * - `bitDepth` is the picture precision promised: 10 for Main10, 10-bit AV1 and ProRes 422 HQ. The
 *   8-bit matrix formats promise an 8-bit picture even when the codec stores more (ProRes 422 is
 *   always written as a 10-bit 4:2:2 file).
 * - `textTrack` is the subtitle codec an embedded caption track uses in this container.
 */

export type StudioExportFormatKind = 'video' | 'audio' | 'still';

export type StudioExportFormatSpec = {
  kind: StudioExportFormatKind;
  container: string;
  /** ffprobe `codec_name` of the main stream. */
  codec: string;
  contentType: string;
  extension: string;
  bitDepth: 8 | 10;
  writers: readonly string[];
  combination: boolean;
  textTrack?: 'mov_text' | 'subrip' | 'webvtt';
};

const H264 = [
  'webcodecs-avc',
  'libx264',
  'h264_nvenc',
  'h264_qsv',
  'h264_vaapi',
  'h264_videotoolbox',
  'h264_amf',
  'h264_rkmpp',
  'h264_v4l2m2m',
] as const;
const HEVC = [
  'libx265',
  'hevc_nvenc',
  'hevc_qsv',
  'hevc_vaapi',
  'hevc_videotoolbox',
  'hevc_amf',
  'hevc_rkmpp',
  'hevc_v4l2m2m',
] as const;
const AV1 = ['libsvtav1', 'libaom-av1', 'librav1e', 'av1_nvenc', 'av1_qsv', 'av1_vaapi', 'av1_amf'] as const;
const VP8 = ['libvpx', 'vp8_vaapi', 'vp8_qsv'] as const;
const VP9 = ['libvpx-vp9', 'vp9_vaapi', 'vp9_qsv'] as const;
const PRORES = ['prores_ks', 'prores', 'prores_aw', 'prores_videotoolbox'] as const;

const MP4 = { container: 'mp4', contentType: 'video/mp4', extension: '.mp4', textTrack: 'mov_text' } as const;
const MOV = { container: 'mov', contentType: 'video/quicktime', extension: '.mov', textTrack: 'mov_text' } as const;
const MKV = { container: 'mkv', contentType: 'video/x-matroska', extension: '.mkv', textTrack: 'subrip' } as const;
const WEBM = { container: 'webm', contentType: 'video/webm', extension: '.webm', textTrack: 'webvtt' } as const;

const video = (
  box: typeof MP4 | typeof MOV | typeof MKV | typeof WEBM,
  codec: string,
  writers: readonly string[],
  bitDepth: 8 | 10 = 8,
  combination = true,
): StudioExportFormatSpec => ({ kind: 'video', ...box, codec, writers, bitDepth, combination });

const audio = (
  container: string,
  codec: string,
  contentType: string,
  extension: string,
  writers: readonly string[],
): StudioExportFormatSpec => ({
  kind: 'audio',
  container,
  codec,
  contentType,
  extension,
  writers,
  bitDepth: 8,
  combination: true,
});

const still = (container: string, writer: string, contentType: string, extension: string): StudioExportFormatSpec => ({
  kind: 'still',
  container,
  codec: container,
  contentType,
  extension,
  writers: [writer],
  bitDepth: 8,
  combination: false,
});

export const STUDIO_EXPORT_FORMAT_SPECS = {
  // The original formats, in their original order.
  'mp4-hevc-main10': video(MP4, 'hevc', HEVC, 10, false),
  'mp4-h264': video(MP4, 'h264', H264, 8, false),
  'webm-av1': video(WEBM, 'av1', AV1, 10, false),
  'prores-422-hq': video(MOV, 'prores', PRORES, 10, false),
  'sdr-jpeg': still('jpeg', 'frameleaf-sdr-jpeg', 'image/jpeg', '.jpg'),
  'hdr-jpeg': { ...still('jpeg', 'frameleaf-ultrahdr-jpeg', 'image/jpeg', '.jpg'), bitDepth: 10 },
  'hdr-heic': { ...still('heic', 'frameleaf-heic-pq', 'image/heic', '.heic'), bitDepth: 10 },
  // FL-105: the 8-bit SDR container × codec matrix.
  'mp4-hevc': video(MP4, 'hevc', HEVC),
  'mp4-av1': video(MP4, 'av1', AV1),
  'mov-h264': video(MOV, 'h264', H264),
  'mov-hevc': video(MOV, 'hevc', HEVC),
  'mov-prores-422': video(MOV, 'prores', PRORES),
  'mkv-h264': video(MKV, 'h264', H264),
  'mkv-hevc': video(MKV, 'hevc', HEVC),
  'mkv-vp8': video(MKV, 'vp8', VP8),
  'mkv-vp9': video(MKV, 'vp9', VP9),
  'mkv-av1': video(MKV, 'av1', AV1),
  'webm-vp8': video(WEBM, 'vp8', VP8),
  'webm-vp9': video(WEBM, 'vp9', VP9),
  'webm-av1-sdr': video(WEBM, 'av1', AV1),
  // FL-105: the project's sound alone.
  'audio-mp3': audio('mp3', 'mp3', 'audio/mpeg', '.mp3', ['libmp3lame']),
  'audio-aac': audio('m4a', 'aac', 'audio/mp4', '.m4a', ['aac', 'libfdk_aac', 'aac_at']),
  'audio-wav': audio('wav', 'pcm_s16le', 'audio/wav', '.wav', ['pcm_s16le']),
} as const satisfies Record<string, StudioExportFormatSpec>;

export type StudioExportFormatId = keyof typeof STUDIO_EXPORT_FORMAT_SPECS;

export const studioExportFormatSpec = (format: unknown): StudioExportFormatSpec | null =>
  typeof format === 'string' && Object.hasOwn(STUDIO_EXPORT_FORMAT_SPECS, format)
    ? STUDIO_EXPORT_FORMAT_SPECS[format as StudioExportFormatId]
    : null;

export const isStudioVideoFormat = (format: unknown): boolean => studioExportFormatSpec(format)?.kind === 'video';
export const isStudioAudioFormat = (format: unknown): boolean => studioExportFormatSpec(format)?.kind === 'audio';

/** Sample rates each audio-only codec can carry; an export never resamples the project's sound. */
const AUDIO_RATES: Readonly<Record<string, readonly number[]>> = {
  mp3: [8000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000],
  aac: [8000, 11_025, 12_000, 16_000, 22_050, 24_000, 32_000, 44_100, 48_000, 64_000, 88_200, 96_000],
};

/**
 * Why this format cannot carry the export's promised sound unchanged, or null. Checked before the
 * export is queued, so the person reads it on the export sheet instead of in a failed job.
 */
export const studioExportAudioProblem = (
  format: string,
  audio: { policy: string; channels: number | null; sampleRate: number | null } | null,
): string | null => {
  const spec = studioExportFormatSpec(format);
  if (spec?.kind !== 'audio') {
    return null;
  }
  if (!audio) {
    return 'This project has no sound to export. Add audio, or export a video.';
  }
  const channels = audio.policy === 'stereo' ? 2 : audio.channels;
  if (spec.codec === 'mp3' && channels !== null && channels > 2) {
    return `MP3 holds at most two channels and this project's sound has ${channels}. Choose Stereo, or export AAC or WAV.`;
  }
  const rates = AUDIO_RATES[spec.codec];
  if (rates && audio.sampleRate !== null && !rates.includes(audio.sampleRate)) {
    return `${spec.codec === 'mp3' ? 'MP3' : 'AAC'} cannot hold sound sampled at ${audio.sampleRate} Hz without resampling it. Export WAV instead.`;
  }
  return null;
};
