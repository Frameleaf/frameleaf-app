import { join, parse } from 'node:path';

/**
 * FL-1285: DJI drones and Osmo cameras write the colour mode only to the optional `.SRT` caption
 * sidecar they record next to a clip (`DJI_0001.MP4` + `DJI_0001.SRT`), on each caption line:
 *
 *   [iso : 100] [shutter : 1/200.0] [fnum : 1.7] [ev : 0] [color_md : d_log] [focal_len : 24.00] ...
 *
 * Self-contained on purpose: the SRT GPS reader (FL-968, `dji-srt.ts`) parses the same files for a
 * different job, and either change can land first.
 */

/** Only the first caption is needed; the colour mode does not change within a clip. */
export const DJI_SRT_HEAD_BYTES = 8192;

/** Where DJI puts the sidecar, following the `IMG_123.xmp` convention used for XMP sidecars. */
export const getDjiSrtCandidates = (originalPath: string) => {
  const { dir, name } = parse(originalPath);
  return [`${join(dir, name)}.SRT`, `${join(dir, name)}.srt`];
};

/** The `color_md` value of the first caption that has one, lower-cased (e.g. "d_log", "default"). */
export const parseDjiSrtColorMode = (text: string): string | null => {
  const match = /\[\s*color_md\s*:\s*([\w-]+)\s*]/i.exec(text);
  return match ? match[1].toLowerCase() : null;
};
