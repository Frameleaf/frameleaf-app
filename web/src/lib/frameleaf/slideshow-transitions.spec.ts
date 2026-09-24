import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SLIDESHOW_TRANSITION,
  effectiveTransition,
  kenBurnsMove,
  parseSlideshowTransition,
  SLIDESHOW_TRANSITIONS,
  SlideshowTransition,
  slideshowTransitionSerializer,
} from './slideshow-transitions';

describe('slideshow transitions (FL-36)', () => {
  it('lists the five transitions in the template order, with fade as the default', () => {
    expect(SLIDESHOW_TRANSITIONS).toEqual(['none', 'fade', 'slide', 'ken-burns', 'memories']);
    expect(DEFAULT_SLIDESHOW_TRANSITION).toBe(SlideshowTransition.Fade);
  });

  it('migrates the legacy boolean: true is fade, false is none', () => {
    expect(parseSlideshowTransition(true)).toBe(SlideshowTransition.Fade);
    expect(parseSlideshowTransition(false)).toBe(SlideshowTransition.None);
    expect(slideshowTransitionSerializer.parse('true')).toBe(SlideshowTransition.Fade);
    expect(slideshowTransitionSerializer.parse('false')).toBe(SlideshowTransition.None);
  });

  it('keeps a stored transition and falls back to fade for anything unknown', () => {
    expect(slideshowTransitionSerializer.parse('"ken-burns"')).toBe(SlideshowTransition.KenBurns);
    expect(slideshowTransitionSerializer.parse('"memories"')).toBe(SlideshowTransition.Memories);
    expect(slideshowTransitionSerializer.parse('"wipe"')).toBe(SlideshowTransition.Fade);
    expect(slideshowTransitionSerializer.parse('not json')).toBe(SlideshowTransition.Fade);
    expect(slideshowTransitionSerializer.parse('42')).toBe(SlideshowTransition.Fade);
    expect(slideshowTransitionSerializer.stringify(SlideshowTransition.Slide)).toBe('"slide"');
  });

  it('turns moving transitions into a fade under Reduce Motion', () => {
    for (const moving of [SlideshowTransition.Slide, SlideshowTransition.KenBurns, SlideshowTransition.Memories]) {
      expect(effectiveTransition(moving, true)).toBe(SlideshowTransition.Fade);
      expect(effectiveTransition(moving, false)).toBe(moving);
    }
    expect(effectiveTransition(SlideshowTransition.None, true)).toBe(SlideshowTransition.None);
    expect(effectiveTransition(SlideshowTransition.Fade, true)).toBe(SlideshowTransition.Fade);
    expect(effectiveTransition('bogus', false)).toBe(SlideshowTransition.Fade);
  });

  it('moves the same asset the same way every time', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'asset-1', 'asset-2', '00000000-0000-4000-8000-000000000000'];
    for (const id of ids) {
      expect(kenBurnsMove(id)).toEqual(kenBurnsMove(id));
      expect(kenBurnsMove(id).from).toMatch(/^scale\(/);
      expect(kenBurnsMove(id).to).toMatch(/^scale\(/);
    }
    // the moves are spread across assets rather than one for all
    expect(new Set(ids.map((id) => kenBurnsMove(id).to)).size).toBeGreaterThan(1);
    expect(kenBurnsMove(undefined)).toEqual(kenBurnsMove(''));
  });
});
