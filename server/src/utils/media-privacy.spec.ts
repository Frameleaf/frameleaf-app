import { describe, expect, it } from 'vitest';
import {
  STRIP_VIDEO_METADATA_OPTIONS,
  strippedStillFormat,
  strippedVideoStreams,
  stripsVideoMetadata,
} from 'src/utils/media-privacy.js';

describe('media privacy for copies made for another machine (FL-162)', () => {
  it('drops container, stream and chapter metadata and the creation stamps', () => {
    expect(STRIP_VIDEO_METADATA_OPTIONS).toEqual([
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
    ]);
    expect(stripsVideoMetadata(['-c:v', 'copy', ...STRIP_VIDEO_METADATA_OPTIONS])).toBe(true);
    expect(stripsVideoMetadata(['-map_metadata', '-1'])).toBe(false);
  });

  it('keeps only the first video stream, and audio only when asked, never data or subtitle streams', () => {
    expect(strippedVideoStreams(true)).toEqual(['-map', '0:v:0', '-map', '0:a:0?']);
    expect(strippedVideoStreams(false)).toEqual(['-map', '0:v:0', '-an']);
  });

  it('keeps a JPEG a JPEG and writes every other still as PNG', () => {
    expect(strippedStillFormat('IMG_0001.JPG')).toBe('jpeg');
    expect(strippedStillFormat('scan.jpeg')).toBe('jpeg');
    expect(strippedStillFormat('screenshot.png')).toBe('png');
    expect(strippedStillFormat('photo.webp')).toBe('png');
  });
});
