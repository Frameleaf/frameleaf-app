import { describe, expect, it } from 'vitest';
import {
  voiceAnalysisWindow,
  voiceCleanupClipOf,
  voiceCleanupWindow,
  voiceNoisesOf,
  voiceSeconds,
} from 'src/utils/studio-voice-cleanup.js';

const asset = '0195e2a0-0000-7000-8000-000000000031';
const imported = '0195e2a0-0000-4000-8000-000000000032';
const graphOf = (clip: Record<string, unknown>) => ({
  metadata: { fps: 30 },
  timeline: { items: [{ id: 'voice', type: 'audio', from: 0, durationInFrames: 60, sourceFps: 30, ...clip }] },
});

describe('voiceCleanupClipOf', () => {
  it('reads the clip window and every key its media can resolve under', () => {
    const clip = voiceCleanupClipOf(graphOf({ mediaId: asset, sourceStart: 30, sourceEnd: 90 }), 'voice');
    expect(clip.sourceKeys).toEqual([`library-asset:${asset}`, `project-import:${asset}`]);
    expect(voiceSeconds(clip.sourceStart)).toBe(1);
    expect(voiceSeconds(clip.sourceEnd)).toBe(3);
  });

  it('reads a cleaned clip from its original', () => {
    const clip = voiceCleanupClipOf(
      graphOf({
        mediaId: imported,
        sourceStart: 30,
        sourceEnd: 90,
        voiceCleanup: { original: { mediaId: asset, sourceStart: 300, sourceEnd: 360 } },
      }),
      'voice',
    );
    expect(clip.mediaId).toBe(asset);
    expect(voiceSeconds(clip.sourceStart)).toBe(10);
  });

  it('maps a trim made after the clean-up back onto the original', () => {
    const clip = voiceCleanupClipOf(
      graphOf({
        mediaId: imported,
        sourceStart: 40,
        sourceEnd: 85,
        voiceCleanup: { cleanedStart: 30, original: { mediaId: asset, sourceStart: 300, sourceEnd: 360 } },
      }),
      'voice',
    );
    // Ten frames later and 45 long, in the original as in the cleaned sound.
    expect(voiceSeconds(clip.sourceStart)).toBeCloseTo(310 / 30, 3);
    expect(voiceSeconds(clip.sourceEnd)).toBeCloseTo(355 / 30, 3);
  });

  it('refuses what it cannot clean', () => {
    expect(() => voiceCleanupClipOf(graphOf({ type: 'video', mediaId: asset, sourceEnd: 30 }), 'voice')).toThrow(
      'Only a clip with sound',
    );
    expect(() => voiceCleanupClipOf(graphOf({ mediaId: asset }), 'voice')).toThrow('no exact source window');
    expect(() => voiceCleanupClipOf(graphOf({ mediaId: asset, sourceEnd: 30 }), 'other')).toThrow('not on the main');
    expect(() =>
      voiceCleanupClipOf(graphOf({ generatedId: 'reverse-x', mediaId: asset, sourceEnd: 30 }), 'voice'),
    ).toThrow('does not play media');
  });
});

describe('voiceCleanupWindow', () => {
  it('adds a second of handle each side, never before the source starts', () => {
    const near = voiceCleanupWindow(
      voiceCleanupClipOf(graphOf({ mediaId: asset, sourceStart: 15, sourceEnd: 75 }), 'voice'),
    );
    expect(voiceSeconds(near.handleBefore)).toBe(0.5);
    expect(near.startSeconds).toBe('0.000000');
    expect(near.durationSeconds).toBe('3.500000');
    const far = voiceCleanupWindow(
      voiceCleanupClipOf(graphOf({ mediaId: asset, sourceStart: 300, sourceEnd: 360 }), 'voice'),
    );
    expect(voiceSeconds(far.handleBefore)).toBe(1);
    expect(far.startSeconds).toBe('9.000000');
  });

  it('listens to at most a minute for the analysis', () => {
    const clip = voiceCleanupClipOf(graphOf({ mediaId: asset, sourceStart: 0, sourceEnd: 30 * 120 }), 'voice');
    expect(voiceAnalysisWindow(clip)).toEqual({ startSeconds: '0.000000', durationSeconds: '60.000000' });
  });
});

describe('voiceNoisesOf', () => {
  it('keeps the known noises in order, once each', () => {
    expect(voiceNoisesOf(['echo', 'wind', 'echo', 'traffic'])).toEqual(['wind', 'echo']);
  });
});
