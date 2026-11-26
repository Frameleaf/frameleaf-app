import { mdiFolderOutline } from '@mdi/js';
import { render, waitFor } from '@testing-library/svelte';
import { resetIconCatalogueCache } from '$lib/frameleaf/icon-catalogue';
import AlbumIcon from './AlbumIcon.svelte';

const tabler = { rollercoaster: { strokes: [[2, 'M3 21a5 5 0 0 1 5-5']] }, 'star-filled': 'M8 4l4 8' };

describe('AlbumIcon', () => {
  beforeEach(() => {
    resetIconCatalogueCache();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url === '/icon-packs/tabler.json'
          ? Promise.resolve(Response.json(tabler))
          : Promise.reject(new Error(`unexpected fetch: ${url}`)),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws an outline pack icon as round strokes once its pack arrives', async () => {
    const { container } = render(AlbumIcon, { name: 'tabler:rollercoaster', size: '20' });
    expect(container.querySelector('path')).toHaveAttribute('d', mdiFolderOutline);

    await waitFor(() => expect(container.querySelector('path')).toHaveAttribute('d', 'M3 21a5 5 0 0 1 5-5'));
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
    expect(svg).toHaveAttribute('width', '20');
    expect(svg).toHaveAttribute('stroke', 'currentColor');
    expect(svg).toHaveAttribute('fill', 'none');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('path')).toHaveAttribute('stroke-width', '2');
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/icon-packs/tabler.json');
  });

  it('draws a filled pack icon like a Material Design icon, and a second icon without another fetch', async () => {
    const first = render(AlbumIcon, { name: 'tabler:star-filled' });
    await waitFor(() => expect(first.container.querySelector('path')).toHaveAttribute('d', 'M8 4l4 8'));
    expect(first.container.querySelector('path')).toHaveAttribute('fill', 'currentColor');

    const second = render(AlbumIcon, { name: 'tabler:rollercoaster' });
    expect(second.container.querySelector('path')).toHaveAttribute('d', 'M3 21a5 5 0 0 1 5-5');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps the default icon when the pack cannot be loaded', async () => {
    const { container } = render(AlbumIcon, { name: 'material-symbols:castle' });
    await waitFor(() => expect(fetch).toHaveBeenCalledWith('/icon-packs/material-symbols.json'));
    expect(container.querySelector('path')).toHaveAttribute('d', mdiFolderOutline);
  });
});
