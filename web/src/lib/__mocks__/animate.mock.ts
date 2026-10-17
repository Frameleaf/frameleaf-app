import { tick } from 'svelte';
import { vi } from 'vitest';

export const getAnimateMock = () =>
  vi.fn().mockImplementation(function () {
    let onfinish: (() => void) | null = null;
    void tick().then(() => onfinish?.());

    const animation = {
      playState: 'running' as AnimationPlayState,
      set onfinish(fn: () => void) {
        onfinish = fn;
      },
      cancel() {
        onfinish = null;
      },
      pause() {
        animation.playState = 'paused';
      },
      play() {
        animation.playState = 'running';
      },
    };
    return animation;
  });
