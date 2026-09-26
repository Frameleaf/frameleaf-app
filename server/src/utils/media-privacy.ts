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

/** Whether ffmpeg options carry every metadata-stripping option above, in order (FL-162 checks). */
export const stripsVideoMetadata = (options: readonly string[]): boolean => {
  const joined = options.join(' ');
  return joined.includes(STRIP_VIDEO_METADATA_OPTIONS.join(' '));
};

/** The still format a stripped copy is written in: a JPEG stays a JPEG, anything else becomes PNG. */
export const strippedStillFormat = (fileName: string): 'jpeg' | 'png' => (/\.jpe?g$/i.test(fileName) ? 'jpeg' : 'png');
