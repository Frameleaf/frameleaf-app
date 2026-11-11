import type { UserPreferencesResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LibraryViewMenu from '$lib/components/frameleaf/LibraryViewMenu.svelte';
import { LibraryGridPreferences } from '$lib/frameleaf/library-grid-preferences.svelte';
import type { LibraryViewMenuOptions } from '$lib/frameleaf/library-view';
import { LibraryViewStore } from '$lib/frameleaf/library-view.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';

const library: LibraryViewMenuOptions = {
  layout: 'browse',
  grid: true,
  scrubber: false,
  stacks: true,
  libraryRoot: true,
};

const setup = (options: LibraryViewMenuOptions | null = library, props = {}) => {
  const view = new LibraryViewStore();
  const preferences = new LibraryGridPreferences();
  const onToggleInspector = vi.fn();
  render(LibraryViewMenu, {
    options: options ?? undefined,
    view,
    preferences,
    inspectorOpen: false,
    onToggleInspector,
    ...props,
  });
  return { view, preferences, onToggleInspector };
};
const row = (name: string) => screen.getByRole('switch', { name });

describe(LibraryViewMenu.name, () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.spyOn(authManager, 'authenticated', 'get').mockReturnValue(true);
    vi.spyOn(authManager, 'isSharedLink', 'get').mockReturnValue(false);
    vi.spyOn(authManager, 'preferences', 'get').mockReturnValue({} as UserPreferencesResponseDto);
    sdkMock.getPartners.mockResolvedValue([]);
  });

  it('is the information panel switch alone where a page offers nothing else', async () => {
    const { onToggleInspector } = setup(null);
    expect(screen.getAllByRole('switch')).toHaveLength(1);
    await fireEvent.click(row('frameleaf_work_inspector_show'));
    expect(onToggleInspector).toHaveBeenCalledOnce();
    expect(screen.queryByText('frameleaf_library_view_reset')).not.toBeInTheDocument();
  });

  it('keeps time and file name for the layout it is opened in', async () => {
    const { view } = setup({ ...library, layout: 'work', grid: true });
    expect(row('frameleaf_library_view_time')).toBeChecked();
    expect(row('frameleaf_library_view_file_name')).not.toBeChecked();
    await fireEvent.click(row('frameleaf_library_view_file_name'));
    expect(view.value).toMatchObject({ workNames: true, browseNames: false, timelineNames: false });
  });

  it('offers the year scrubber in the Timeline, and Crop and Group by in a grid', () => {
    setup({ ...library, layout: 'timeline', grid: false, scrubber: true });
    expect(row('frameleaf_library_view_scrubber')).toBeChecked();
    expect(screen.queryByRole('switch', { name: 'frameleaf_library_view_crop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /frameleaf_library_view_group_by/ })).not.toBeInTheDocument();
  });

  it('sets the Thumbnail size from the presets', async () => {
    const { preferences } = setup();
    const sizes = within(screen.getByRole('group', { name: 'size' }));
    expect(sizes.getByRole('button', { name: 'frameleaf_library_view_size_medium' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await fireEvent.click(sizes.getByRole('button', { name: 'frameleaf_library_view_size_large' }));
    expect(preferences.thumbnailSize).toBe(260);
  });

  it('opens Group by as a second page whose first row goes back to the row it came from', async () => {
    const { view } = setup();
    const more = screen.getByRole('button', { name: /frameleaf_library_view_group_by/ });
    expect(more).toHaveTextContent('none');
    await fireEvent.click(more);

    const back = screen.getByRole('button', { name: /back.*frameleaf_library_view_group_by/ });
    await waitFor(() => expect(back).toHaveFocus());
    expect(screen.queryByText('frameleaf_library_view_show_on_photos')).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'month' }));
    expect(view.value.groupBy).toBe('month');
    expect(screen.getByRole('menuitemradio', { name: 'month' })).toBeChecked();

    await fireEvent.click(back);
    const again = screen.getByRole('button', { name: /frameleaf_library_view_group_by/ });
    await waitFor(() => expect(again).toHaveFocus());
    expect(again).toHaveTextContent('month');
  });

  it('chooses between keeping stacks together and showing every photo', async () => {
    const { view } = setup();
    await fireEvent.click(screen.getByRole('button', { name: /frameleaf_library_view_stacks/ }));
    expect(screen.getByRole('menuitemradio', { name: 'frameleaf_library_view_stacks_together' })).toBeChecked();
    await fireEvent.click(screen.getByRole('menuitemradio', { name: 'frameleaf_library_view_stacks_apart' }));
    expect(view.value.stacksTogether).toBe(false);
  });

  it('leaves Stacks out where the page shows every photo, and Also show off the Library root', () => {
    setup({ ...library, stacks: false, libraryRoot: false });
    expect(screen.queryByRole('button', { name: /frameleaf_library_view_stacks/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /frameleaf_library_view_also_show/ })).not.toBeInTheDocument();
  });

  it('names the one partner who shares under Also show, and says Locked never shows', async () => {
    sdkMock.getPartners.mockResolvedValue([{ name: 'Jamie' }] as never);
    const { view } = setup();
    const more = screen.getByRole('button', { name: /frameleaf_library_view_also_show/ });
    expect(more).toHaveTextContent('frameleaf_library_partner_photos');
    await fireEvent.click(more);
    expect(await screen.findByRole('switch', { name: 'frameleaf_library_view_also_partner' })).toBeChecked();
    expect(screen.getByText('frameleaf_library_view_also_locked')).toBeInTheDocument();
    await fireEvent.click(row('frameleaf_library_view_also_archived'));
    await fireEvent.click(row('frameleaf_library_view_also_partner'));
    expect(view.value).toMatchObject({ archived: true, partnerPhotos: false });
  });

  it('puts every option and the size back with Reset view', async () => {
    const { view, preferences } = setup();
    preferences.thumbnailSize = 140;
    view.set({ ratings: false, groupBy: 'year', browseTime: true });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_library_view_reset' }));
    expect(view.value).toMatchObject({ ratings: true, groupBy: 'none', browseTime: false });
    expect(preferences.thumbnailSize).toBe(200);
  });
});
