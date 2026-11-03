import { render } from '@testing-library/svelte';
import { filmstripPlaceholder } from '$lib/frameleaf/viewer-filmstrip';
import ViewerFilmstrip from './ViewerFilmstrip.svelte';

const items = (count: number) =>
  Array.from({ length: count }, (_, index) => filmstripPlaceholder({ id: `asset-${index}`, ownerId: 'me' }));

describe('ViewerFilmstrip', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockClear();
    Element.prototype.scrollIntoView = scrollIntoView;
  });

  const centredOn = () =>
    scrollIntoView.mock.contexts.map(
      (element) => (element as Element).querySelector<HTMLElement>('[data-asset]')?.dataset.asset,
    );

  it('centres the open item at once when it opens', () => {
    render(ViewerFilmstrip, { assets: items(5), currentAssetId: 'asset-3', onSelect: vi.fn() });
    expect(centredOn()).toEqual(['asset-3']);
    expect(scrollIntoView).toHaveBeenLastCalledWith(expect.objectContaining({ inline: 'center', behavior: 'auto' }));
  });

  // LIB-02: the strip opened with a few neighbours, the rest of the month came after, and the strip stayed at
  // its start with the open item far off to the side
  it('centres the open item again when the list grows around it', async () => {
    const view = render(ViewerFilmstrip, { assets: items(3).slice(1), currentAssetId: 'asset-2', onSelect: vi.fn() });
    scrollIntoView.mockClear();

    await view.rerender({ assets: items(40), currentAssetId: 'asset-2' });

    expect(centredOn()).toEqual(['asset-2']);
    expect(scrollIntoView).toHaveBeenLastCalledWith(expect.objectContaining({ inline: 'center', behavior: 'auto' }));
  });

  it('glides to the next item as the viewer moves', async () => {
    const assets = items(10);
    const view = render(ViewerFilmstrip, { assets, currentAssetId: 'asset-3', onSelect: vi.fn() });

    await view.rerender({ assets, currentAssetId: 'asset-4' });

    expect(centredOn().at(-1)).toBe('asset-4');
    expect(scrollIntoView).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'smooth' }));
  });
});
