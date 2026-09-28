import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { resetIconCatalogueCache } from '$lib/frameleaf/icon-catalogue';
import IconChooser from './IconChooser.svelte';

const catalogue = {
  version: '7.4.47',
  names: ['mdiCameraBurst', 'mdiCameraOutline', 'mdiFolderMultipleOutline', 'mdiImageAlbum', 'mdiZodiacVirgo'],
  suggested: [
    {
      label: 'Albums and photos',
      icons: [
        { name: 'mdiImageAlbum', label: 'Album' },
        { name: 'mdiCameraOutline', label: 'Camera' },
      ],
    },
  ],
};

describe('IconChooser', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetIconCatalogueCache();
    sdkMock.getAlbumIconCatalogue.mockResolvedValue(catalogue);
  });

  it('loads the catalogue from the server and shows the suggested set before every icon', async () => {
    render(IconChooser, { value: 'mdiImageAlbum', onChange: vi.fn(), inline: true });

    await waitFor(() => expect(screen.getByRole('listbox', { name: 'Albums and photos' })).toBeInTheDocument());
    expect(sdkMock.getAlbumIconCatalogue).toHaveBeenCalledTimes(1);
    // The suggested set comes first; the same icon appears again under every icon.
    const suggested = screen.getByRole('listbox', { name: 'Albums and photos' });
    expect(within(suggested).getByRole('option', { name: 'Album' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option', { name: 'Album' })).toHaveLength(2);
    expect(screen.getByText('All icons · 5')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'zodiac virgo' })).toBeInTheDocument();
  });

  it('filters the whole catalogue as you type and reports the count', async () => {
    const onChange = vi.fn();
    render(IconChooser, { value: null, onChange, inline: true });
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search icons' })).toBeEnabled());

    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search icons' }), { target: { value: 'camera' } });

    expect(screen.getByText('2 matching icons')).toBeInTheDocument();
    expect(screen.queryByRole('listbox', { name: 'Albums and photos' })).toBeNull();
    await fireEvent.click(screen.getByRole('option', { name: 'camera burst' }));
    expect(onChange).toHaveBeenCalledWith('mdiCameraBurst');
  });

  it('says so when nothing matches, and reports a failed catalogue load with a retry', async () => {
    render(IconChooser, { value: null, onChange: vi.fn(), inline: true });
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search icons' })).toBeEnabled());
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search icons' }), {
      target: { value: 'nothing here' },
    });
    expect(screen.getByText('No icons match. Try a shorter word.')).toBeInTheDocument();

    resetIconCatalogueCache();
    sdkMock.getAlbumIconCatalogue.mockRejectedValueOnce(new Error('offline'));
    render(IconChooser, { value: null, onChange: vi.fn(), inline: true });
    await waitFor(() =>
      expect(screen.getAllByRole('status').at(-1)).toHaveTextContent('Unable to load the icon catalogue'),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('closes the popover on Escape and never submits an enclosing form from the search', async () => {
    const onClose = vi.fn();
    render(IconChooser, { value: null, onChange: vi.fn(), onClose });
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Choose an icon' })).toBeInTheDocument());

    const search = screen.getByRole('searchbox', { name: 'Search icons' });
    await fireEvent.keyDown(search, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    await fireEvent.keyDown(search, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
