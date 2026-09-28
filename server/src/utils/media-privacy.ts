/**
 * What a copy of a photo or video made for another machine keeps and drops (FL-162).
 *
 * Frameleaf Cloud (and a restoration worker on the home network) is sent pixels, never metadata:
 * no location, no camera make or serial, no dates, no names, no chapters. Stills are re-encoded with
 * only their ICC colour profile kept (`MediaRepository.writeStrippedStill`); videos are cut or copied
 * with the ffmpeg options below.
 */

/**
 * ffmpeg output options that keep no metadata: no container tags (GPS, camera, dates, names), no
 * per-stream tags, no chapters, and no encoder or creation-time stamps.
 */
export const STRIP_VIDEO_METADATA_OPTIONS: readonly string[] = [
  '-map_metadata',
  '-1',
  '-map_metadata:s:v',
  '-1',
  '-map_metadata:s:a',
  '-1',
  '-map_chapters',
  '-1',
  '-fflags',
  '+bitexact',
];

/**
 * The streams such a copy keeps: the first video stream and, when `audio` is true, the first audio
 * stream. Data, subtitle and attachment streams (a camera's GPS track or timed metadata among them)
 * are never mapped.
 */
export const strippedVideoStreams = (audio: boolean): string[] =>
  audio ? ['-map', '0:v:0', '-map', '0:a:0?'] : ['-map', '0:v:0', '-an'];

/**
 * The comparison clip of a video preview: the first video and audio streams re-encoded (H.264 CRF 16
 * and AAC) so the before and after previews play in step, optionally cropped, with no metadata.
 */
export const previewClipOutputOptions = (crop: readonly string[] = []): string[] => [
  ...strippedVideoStreams(true),
  ...crop,
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '16',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-b:a',
  '192k',
  ...STRIP_VIDEO_METADATA_OPTIONS,
  '-movflags',
  '+faststart',
];

/** What is uploaded from a preview clip: its video stream copied, without audio or metadata. */
export const uploadClipOutputOptions = (): string[] => [
  ...strippedVideoStreams(false),
  '-c:v',
  'copy',
  ...STRIP_VIDEO_METADATA_OPTIONS,
  '-movflags',
  '+faststart',
];

/**
 * What is uploaded of a whole video for Frameleaf Cloud restoration or Smooth motion (CLD-202): its
 * first video stream only, stream-copied when its codec allows it (`copy`), otherwise re-encoded at
 * high quality, never with audio (`-an`; FC-47, owner decision 2026-09-27: audio is never sent, and
 * the worker refuses a clip that still carries an audio stream) and never with metadata. `bsf` drops
 * a stream copy's SEI messages, where cameras put their own data.
 */
export const fullVideoUploadOutputOptions = (options: { copy: boolean; bsf?: string; webm?: boolean }): string[] => [
  ...strippedVideoStreams(false),
  ...(options.copy
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p']),
  ...(options.bsf ? ['-bsf:v', options.bsf] : []),
  ...STRIP_VIDEO_METADATA_OPTIONS,
  ...(options.webm ? [] : ['-movflags', '+faststart']),
];

/**
 * How far the audio's first sample was from the picture's first frame in the file the audio comes
 * from, in seconds (positive: the audio starts later). ffmpeg moves each input so its earliest stream
 * starts at 0; the offset below puts the audio back where it was against the picture. Unknown start
 * times keep ffmpeg's own alignment (0).
 */
export const audioReattachOffsetSeconds = (
  videoStart: number | null | undefined,
  audioStart: number | null | undefined,
) => {
  if (typeof videoStart !== 'number' || typeof audioStart !== 'number') {
    return 0;
  }
  // after ffmpeg's normalisation the audio already sits at (audioStart - min); it belongs at (audioStart - videoStart)
  return Math.min(videoStart, audioStart) - videoStart;
};

/**
 * CLD-202: the options that put a video's own audio back on the picture Frameleaf Cloud returned
 * (which never carried audio): the returned picture and the first audio stream of `audioFrom`, both
 * copied, shifted by `offsetSeconds` so they stay in step, cut to the shorter stream with a tight
 * interleave, and without metadata. Without `audioFrom` the picture is only rewrapped.
 */
export const reattachAudioOutputOptions = (audioFrom: string | null, offsetSeconds = 0): string[] => [
  ...(audioFrom
    ? [
        ...(Math.abs(offsetSeconds) > 1e-6 ? ['-itsoffset', offsetSeconds.toFixed(6)] : []),
        '-i',
        audioFrom,
        '-map',
        '0:v:0',
        '-map',
        '1:a:0?',
      ]
    : ['-map', '0:v:0']),
  '-c:v',
  'copy',
  '-c:a',
  'copy',
  '-shortest',
  '-max_interleave_delta',
  '0',
  ...STRIP_VIDEO_METADATA_OPTIONS,
  '-movflags',
  '+faststart',
];

/** One chunk of a whole video for a restoration worker: near-lossless H.264, no audio, no metadata. */
export const chunkClipOutputOptions = (): string[] => [
  ...strippedVideoStreams(false),
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '10',
  '-pix_fmt',
  'yuv420p',
  ...STRIP_VIDEO_METADATA_OPTIONS,
];

/** Whether ffmpeg options carry every metadata-stripping option above, in order (FL-162 checks). */
export const stripsVideoMetadata = (options: readonly string[]): boolean => {
  const joined = options.join(' ');
  return joined.includes(STRIP_VIDEO_METADATA_OPTIONS.join(' '));
};

/** The still format a stripped copy is written in: a JPEG stays a JPEG, anything else becomes PNG. */
export const strippedStillFormat = (fileName: string): 'jpeg' | 'png' => (/\.jpe?g$/i.test(fileName) ? 'jpeg' : 'png');
