import { confetti } from '$lib/frameleaf/confetti';

const media = vi.hoisted(() => ({ reducedMotion: true }));
vi.mock('$lib/stores/media-query-manager.svelte', () => ({
  mediaQueryManager: {
    get reducedMotion() {
      return media.reducedMotion;
    },
  },
}));

it('honors shared Reduce Motion when the system permits motion', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  try {
    const stop = confetti({ parent: document.createElement('div') });
    expect(context).not.toHaveBeenCalled();
    stop();
  } finally {
    context.mockRestore();
    vi.unstubAllGlobals();
  }
});
