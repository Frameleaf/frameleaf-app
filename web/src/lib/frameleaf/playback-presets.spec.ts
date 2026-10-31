import { ImageFormat, TranscodePolicy } from '@frameleaf/sdk';
import {
  applyPlaybackQuality,
  applyPreviewQuality,
  copyRuleOf,
  PLAYBACK_QUALITIES,
  playbackQualityOf,
  policyOf,
  PREVIEW_QUALITIES,
  previewQualityOf,
} from '$lib/frameleaf/playback-presets';

// The server's own defaults (server/src/dtos/config.dto.ts).
const serverImage = () => ({
  thumbnail: { format: ImageFormat.Webp, size: 250, quality: 80, progressive: false },
  preview: { format: ImageFormat.Jpeg, size: 1440, quality: 80, progressive: false },
});

describe('preview quality (FL-366)', () => {
  it('reads the server defaults as Balanced', () => {
    expect(previewQualityOf(serverImage())).toBe('balanced');
  });

  it('writes each choice and reads it back', () => {
    for (const quality of PREVIEW_QUALITIES) {
      const image = serverImage();
      applyPreviewQuality(image, quality);
      expect(previewQualityOf(image)).toBe(quality);
    }
  });

  it('writes the prototype numbers for Space saver and Sharpest', () => {
    const image = serverImage();
    applyPreviewQuality(image, 'saver');
    expect(image).toMatchObject({
      thumbnail: { format: ImageFormat.Webp, size: 200, quality: 70 },
      preview: { format: ImageFormat.Webp, size: 1080, quality: 70 },
    });
    applyPreviewQuality(image, 'sharp');
    expect(image).toMatchObject({
      thumbnail: { format: ImageFormat.Webp, size: 480, quality: 90 },
      preview: { format: ImageFormat.Jpeg, size: 2160, quality: 90 },
    });
  });

  it('turns off loading progressively when a choice makes a copy WebP', () => {
    const image = serverImage();
    image.preview.progressive = true;
    applyPreviewQuality(image, 'saver');
    expect(image.preview.progressive).toBe(false);
  });

  it('is Custom when one number matches no choice', () => {
    const image = serverImage();
    image.preview.quality = 81;
    expect(previewQualityOf(image)).toBeUndefined();
  });
});

describe('playback quality (FL-366)', () => {
  it('maps the three choices to size and quality number, and leaves the speed alone', () => {
    const ffmpeg = { targetResolution: '720', crf: 23, preset: 'ultrafast' };
    applyPlaybackQuality(ffmpeg, 'better');
    expect(ffmpeg).toEqual({ targetResolution: '1080', crf: 23, preset: 'ultrafast' });
    applyPlaybackQuality(ffmpeg, 'good');
    expect(ffmpeg).toEqual({ targetResolution: '720', crf: 23, preset: 'ultrafast' });
    applyPlaybackQuality(ffmpeg, 'best');
    expect(ffmpeg).toEqual({ targetResolution: '2160', crf: 20, preset: 'ultrafast' });
  });

  it("reads each choice back, and the server's 1080p default as Better", () => {
    for (const quality of PLAYBACK_QUALITIES) {
      const ffmpeg = { targetResolution: '', crf: 0 };
      applyPlaybackQuality(ffmpeg, quality);
      expect(playbackQualityOf(ffmpeg)).toBe(quality);
    }
    expect(playbackQualityOf({ targetResolution: '1080', crf: 23 })).toBe('better');
    expect(playbackQualityOf({ targetResolution: '480', crf: 23 })).toBeUndefined();
  });

  it('maps which videos get a copy to the transcode rule', () => {
    expect(policyOf('needed')).toBe(TranscodePolicy.Required);
    expect(policyOf('all')).toBe(TranscodePolicy.All);
    expect(copyRuleOf(TranscodePolicy.Required)).toBe('needed');
    expect(copyRuleOf(TranscodePolicy.All)).toBe('all');
    expect(copyRuleOf(TranscodePolicy.Optimal)).toBeUndefined();
    expect(copyRuleOf(TranscodePolicy.Disabled)).toBeUndefined();
  });
});
