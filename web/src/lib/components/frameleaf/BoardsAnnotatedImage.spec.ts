import { AssetAnnotationKind, type AssetAnnotationItem } from '@frameleaf/sdk';
import { fireEvent, render } from '@testing-library/svelte';
import BoardsAnnotatedImage from '$lib/components/frameleaf/BoardsAnnotatedImage.svelte';

const items: AssetAnnotationItem[] = [
  { id: 'a1', kind: AssetAnnotationKind.Rect, geometry: { x: 0.1, y: 0.1, width: 0.4, height: 0.2 } },
];

describe('BoardsAnnotatedImage', () => {
  it('ends a move when the annotations are hidden before the pointer lets go', async () => {
    const onMove = vi.fn();
    const view = render(BoardsAnnotatedImage, {
      src: '/preview.jpg',
      name: 'hero.png',
      items,
      interactive: true,
      onMove,
    });
    const shape = view.container.querySelector<SVGGElement>('[data-annotation="a1"]')!;
    await fireEvent.pointerDown(shape, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onMove).not.toHaveBeenCalled();

    await view.rerender({ show: false });
    expect(view.container.querySelector('svg')).toBeNull();
    expect(onMove).toHaveBeenCalledExactlyOnceWith('a1', 0, 0, true);
  });
});
