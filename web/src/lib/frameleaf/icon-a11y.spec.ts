import { Icon } from '@frameleaf/ui';
import { mdiChevronLeft, mdiChevronRight, mdiHeart } from '@mdi/js';
import { render } from '@testing-library/svelte';

// FL-139: the local @frameleaf/ui implementation hides unnamed icons from
// assistive tech instead of announcing an image with no name (axe svg-img-alt).
describe('Icon accessibility', () => {
  it('hides an icon with no accessible name', () => {
    const { container } = render(Icon, { icon: mdiHeart });
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.hasAttribute('role')).toBe(false);
  });

  it('keeps a named icon as an image', () => {
    const titled = render(Icon, { icon: mdiHeart, title: 'Favorite' }).container.querySelector('svg')!;
    expect(titled.getAttribute('role')).toBe('img');
    expect(titled.hasAttribute('aria-hidden')).toBe(false);
    const labelled = render(Icon, { icon: mdiHeart, 'aria-label': 'Favorite' }).container.querySelector('svg')!;
    expect(labelled.getAttribute('role')).toBe('img');
  });

  // FL-139: arrows and chevrons point along the reading direction; app.css mirrors marked ones in RTL
  it('marks the icons that point along the reading direction', () => {
    for (const icon of [mdiChevronLeft, mdiChevronRight]) {
      const svg = render(Icon, { icon }).container.querySelector('svg')!;
      expect(svg.dataset.rtlMirror).toBeDefined();
    }
    expect(render(Icon, { icon: mdiHeart }).container.querySelector('svg')!.dataset.rtlMirror).toBeUndefined();
  });
});
