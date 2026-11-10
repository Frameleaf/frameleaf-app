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

  describe('text in a Boards font (FL-1359)', () => {
    const text = (style: AssetAnnotationItem['style']): AssetAnnotationItem[] => [
      { id: 't1', kind: AssetAnnotationKind.Text, geometry: { x: 0.2, y: 0.4 }, text: 'Hello', style },
    ];
    const draw = (style: AssetAnnotationItem['style']) =>
      render(BoardsAnnotatedImage, { src: '/preview.jpg', name: 'hero.png', items: text(style) });
    const drawn = (view: ReturnType<typeof draw>) => view.container.querySelector<SVGTextElement>(':scope .line text')!;

    afterEach(() => vi.unstubAllGlobals());

    it('draws the size, colour, font and weight once the font has loaded', async () => {
      const add = vi.fn();
      Object.defineProperty(document, 'fonts', { configurable: true, value: { add } });
      vi.stubGlobal(
        'FontFace',
        class {
          constructor(public family: string) {}
          load = () => Promise.resolve(this);
        },
      );
      const view = draw({ fontAssetId: 'font-1', size: 1.4, color: '#ffffff', variation: { wght: 700 } });
      await vi.waitFor(() => expect(drawn(view).style.fontFamily).toContain('fl-font-font-1'));
      expect(add).toHaveBeenCalledOnce();
      expect(drawn(view).getAttribute('font-size')).toBe(String(13 * 1.4));
      expect(drawn(view).style.fontVariationSettings).toBe('"wght" 700');
      const group = view.container.querySelector<SVGGElement>('.ann.text')!;
      expect(group.classList.contains('coloured')).toBe(true);
      expect(group.style.getPropertyValue('--ann-colour')).toBe('#ffffff');
    });

    it('keeps the standard font when the font cannot be loaded', async () => {
      const load = vi.fn(() => Promise.reject(new Error('gone')));
      vi.stubGlobal(
        'FontFace',
        class {
          load = load;
        },
      );
      const view = draw({ fontAssetId: 'font-gone' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      // editing the annotations does not ask for the missing font again
      await view.rerender({ items: text({ fontAssetId: 'font-gone', size: 1.4 }) });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(load).toHaveBeenCalledOnce();
      expect(drawn(view).style.fontFamily).toBe('');
      expect(drawn(view).textContent).toBe('Hello');
    });
  });
});
