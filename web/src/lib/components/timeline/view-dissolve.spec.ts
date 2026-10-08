import { dissolveView } from '$lib/components/timeline/view-dissolve';
import { DURATION } from '$lib/frameleaf/tokens';
import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';

const view = () => {
  const root = document.createElement('div');
  root.innerHTML = `
    <div class="fl-grouping"></div>
    <ul data-testid="frameleaf-timeline-cards"></ul>
    <div class="fl-month"></div>
    <div class="fl-month"></div>`;
  const animate = vi.fn();
  for (const node of root.querySelectorAll('*')) {
    Object.defineProperty(node, 'animate', { configurable: true, value: animate });
  }
  return { root, animate };
};

describe('dissolveView', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fades the cards and the rows of photos up, and leaves the controls alone', () => {
    const { root, animate } = view();
    dissolveView(root);
    expect(animate).toHaveBeenCalledTimes(3);
    expect(animate).toHaveBeenCalledWith(
      [{ opacity: 0 }, { opacity: 1 }],
      expect.objectContaining({ duration: DURATION.fade }),
    );
  });

  it('keeps the fade, shorter, under Reduce Motion', () => {
    vi.spyOn(mediaQueryManager, 'reducedMotion', 'get').mockReturnValue(true);
    const { root, animate } = view();
    dissolveView(root);
    expect(animate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ duration: DURATION.reduced }));
  });

  it('does nothing without a view', () => {
    expect(() => dissolveView(undefined)).not.toThrow();
  });
});
