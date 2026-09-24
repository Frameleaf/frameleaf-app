import { describe, expect, it } from 'vitest';
import {
  MEMORY_PHOTO_MS,
  MEMORY_PREVIEW_MS,
  MEMORY_TITLE_MS,
  memoryLowerThird,
  memoryMotion,
  memoryMotionStyle,
  memoryOverlineKey,
  memoryPhotoMs,
  memoryPreviewMotion,
  memorySlideClass,
  memoryTitleCard,
  memoryTransition,
} from './memory-engine';
import { kenBurnsMove, SlideshowTransition } from './slideshow-transitions';

describe('memory engine (FL-62)', () => {
  it('keeps the template timings', () => {
    expect(MEMORY_PHOTO_MS).toBe(5000);
    expect(MEMORY_TITLE_MS).toBe(2600);
    expect(MEMORY_PREVIEW_MS).toBe(9000);
    expect(memoryPhotoMs(8)).toBe(8000);
    expect(memoryPhotoMs(undefined)).toBe(MEMORY_PHOTO_MS);
    expect(memoryPhotoMs(0)).toBe(MEMORY_PHOTO_MS);
  });

  it('uses the viewer transition rule, so Reduce Motion is a fade', () => {
    expect(memoryTransition(false)).toBe(SlideshowTransition.Memories);
    expect(memoryTransition(true)).toBe(SlideshowTransition.Fade);
  });

  it('drives the shared keyframes with the viewer move for the asset', () => {
    const motion = memoryMotion('asset-1');
    expect(motion).toEqual({
      '--kb-from': kenBurnsMove('asset-1').from,
      '--kb-to': kenBurnsMove('asset-1').to,
      '--kb-duration': '6s',
    });
    expect(memoryMotion('asset-1', { durationMs: 4000 })?.['--kb-duration']).toBe('4s');
    expect(memoryPreviewMotion('cover')?.['--kb-duration']).toBe('9s');
    expect(memoryMotionStyle(motion)).toContain('--kb-from: ');
  });

  it('gives no motion under Reduce Motion or without an item', () => {
    expect(memoryMotion('asset-1', { reducedMotion: true })).toBeUndefined();
    expect(memoryMotion(undefined)).toBeUndefined();
    expect(memoryPreviewMotion('cover', true)).toBeUndefined();
    expect(memoryMotionStyle(undefined)).toBeUndefined();
  });

  it('pans photos, only fades videos, and marks a paused slide', () => {
    expect(memorySlideClass()).toBe('memories');
    expect(memorySlideClass({ video: true })).toBe('fade');
    expect(memorySlideClass({ reducedMotion: true })).toBe('fade');
    expect(memorySlideClass({ paused: true })).toBe('memories paused');
  });

  it('labels the overline by kind', () => {
    expect(memoryOverlineKey('event_story')).toBe('frameleaf_memories_overline_trip');
    expect(memoryOverlineKey('year_in_review')).toBe('frameleaf_memories_overline_highlights');
    expect(memoryOverlineKey('on_this_day')).toBe('frameleaf_memories_overline_memory');
    expect(memoryOverlineKey(undefined)).toBe('frameleaf_memories_overline_memory');
  });

  it('builds the title card and the lower third', () => {
    expect(memoryTitleCard({ kind: 'event_story', title: 'Lisbon', subtitle: 'May 2 – May 6', count: 12 })).toEqual({
      overlineKey: 'frameleaf_memories_overline_trip',
      title: 'Lisbon',
      subtitle: 'May 2 – May 6',
      count: 12,
    });
    expect(memoryLowerThird({ city: 'Porto' }, { fallbackTitle: 'Trip', day: 'May 3' })).toEqual({
      place: 'Porto',
      day: 'May 3',
      video: false,
    });
    expect(memoryLowerThird({ city: null }, { fallbackTitle: 'Trip', video: true })).toEqual({
      place: 'Trip',
      day: '',
      video: true,
    });
    expect(memoryLowerThird(undefined)).toBeNull();
  });
});
