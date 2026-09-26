import { fireEvent, render, screen } from '@testing-library/svelte';
import { LibraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
import ThumbnailSizeControl from './ThumbnailSizeControl.svelte';
import WorkFileNamesToggle from './WorkFileNamesToggle.svelte';

describe('ThumbnailSizeControl', () => {
  beforeEach(() => localStorage.clear());

  it('is a 140–290 slider in steps of 30 on the per-device size', async () => {
    const preferences = new LibraryGridPreferences();
    render(ThumbnailSizeControl, { preferences });
    const slider = screen.getByRole('slider', { name: 'frameleaf_library_thumbnail_size' }) as HTMLInputElement;
    expect(slider).toHaveAttribute('min', '140');
    expect(slider).toHaveAttribute('max', '290');
    expect(slider).toHaveAttribute('step', '30');
    expect(slider.value).toBe('200');
    await fireEvent.input(slider, { target: { value: '260' } });
    expect(preferences.thumbnailSize).toBe(260);
    expect(localStorage.getItem('frameleaf-thumbnail-size')).toBe('260');
  });
});

describe('WorkFileNamesToggle', () => {
  beforeEach(() => localStorage.clear());

  it('turns Work’s file names on and off, pressed while they show', async () => {
    const preferences = new LibraryGridPreferences();
    render(WorkFileNamesToggle, { preferences });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_show_file_names' }));
    expect(preferences.showFileNames).toBe(true);
    const hide = screen.getByRole('button', { name: 'frameleaf_library_hide_file_names' });
    expect(hide).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(hide);
    expect(preferences.showFileNames).toBe(false);
  });
});
