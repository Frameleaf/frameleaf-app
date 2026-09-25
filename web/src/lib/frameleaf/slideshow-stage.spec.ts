import { describe, expect, it } from 'vitest';
import { slideshowStageAnimations } from './slideshow-stage.svelte';
import { kenBurnsMove, SlideshowTransition } from './slideshow-transitions';

const base = { direction: 'next' as const, intervalSeconds: 5, assetId: 'asset-1', video: false };

describe('slideshow stage animations (FL-36)', () => {
  it('does nothing for None', () => {
    expect(slideshowStageAnimations({ ...base, transition: SlideshowTransition.None })).toEqual([]);
  });

  it('fades each new item in', () => {
    const [fade] = slideshowStageAnimations({ ...base, transition: SlideshowTransition.Fade });
    expect(fade.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });

  it('slides from the side it is moving towards, mirrored for right-to-left', () => {
    const offset = (options: Partial<Parameters<typeof slideshowStageAnimations>[0]>) =>
      slideshowStageAnimations({ ...base, transition: SlideshowTransition.Slide, ...options })[0].keyframes[0]
        .transform;
    expect(offset({})).toBe('translateX(48px)');
    expect(offset({ direction: 'previous' })).toBe('translateX(-48px)');
    expect(offset({ rtl: true })).toBe('translateX(-48px)');
  });

  it('pans and zooms photos for the interval plus a second with Ken Burns and Memories', () => {
    for (const transition of [SlideshowTransition.KenBurns, SlideshowTransition.Memories]) {
      const [fade, move] = slideshowStageAnimations({ ...base, transition });
      expect(fade.options.duration).toBe(900);
      expect(move.keyframes).toEqual([
        { transform: kenBurnsMove('asset-1').from },
        { transform: kenBurnsMove('asset-1').to },
      ]);
      expect(move.options.duration).toBe(6000);
    }
  });

  it('never pans or zooms a video', () => {
    const animations = slideshowStageAnimations({ ...base, transition: SlideshowTransition.KenBurns, video: true });
    expect(animations).toHaveLength(1);
    expect(animations[0].keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }]);
  });
});
