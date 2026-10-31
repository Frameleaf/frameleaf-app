import type { TagResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import BoardsTagEditor from './BoardsTagEditor.svelte';

const tag = (id: string, value: string) => ({ id, value, name: value, createdAt: '', updatedAt: '' }) as TagResponseDto;
const texture = tag('t1', 'texture');
const hero = tag('t2', 'hero');
const heritage = tag('t3', 'heritage');

describe('BoardsTagEditor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAllTags.mockResolvedValue([texture, hero, heritage]);
    sdkMock.bulkTagAssets.mockResolvedValue({ count: 1 });
    sdkMock.untagAssets.mockResolvedValue([]);
  });

  it('suggests tags in a list right under the field, not a datalist, and adds the chosen one', async () => {
    const view = render(BoardsTagEditor, { assetId: 'asset', tags: [texture], canEdit: true });
    const input = screen.getByRole('combobox', { name: 'frameleaf_info_add_tag' });
    expect(view.container.querySelector('datalist')).toBeNull();

    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'he' } });
    const listbox = await screen.findByRole('listbox', { name: 'frameleaf_info_tag_suggestions' });
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(input.parentElement).toContainElement(listbox);
    // the item's own tag is not suggested again
    expect(
      within(listbox)
        .getAllByRole('option')
        .map((option) => option.textContent?.trim()),
    ).toEqual(['hero', 'heritage', 'frameleaf_info_create_tag']);

    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveAttribute('aria-activedescendant', within(listbox).getAllByRole('option')[1].id);
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(sdkMock.bulkTagAssets).toHaveBeenCalledWith({ tagBulkAssetsDto: { tagIds: ['t3'], assetIds: ['asset'] } }),
    );
    expect(sdkMock.upsertTags).not.toHaveBeenCalled();
    expect(await screen.findByText('heritage')).toBeInTheDocument();
  });

  it('creates a new tag before adding it', async () => {
    sdkMock.upsertTags.mockResolvedValue([tag('t9', 'moodboard')]);
    render(BoardsTagEditor, { assetId: 'asset', tags: [], canEdit: true });
    const input = screen.getByRole('combobox', { name: 'frameleaf_info_add_tag' });
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'moodboard' } });
    await screen.findByRole('option', { name: /frameleaf_info_create_tag/ });
    await fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() =>
      expect(sdkMock.bulkTagAssets).toHaveBeenCalledWith({ tagBulkAssetsDto: { tagIds: ['t9'], assetIds: ['asset'] } }),
    );
    expect(sdkMock.upsertTags).toHaveBeenCalledWith({ tagUpsertDto: { tags: ['moodboard'] } });
    expect(await screen.findByText('moodboard')).toBeInTheDocument();
  });

  it('removes a tag and offers Retry when a change fails', async () => {
    sdkMock.untagAssets.mockRejectedValueOnce(new Error('offline'));
    render(BoardsTagEditor, { assetId: 'asset', tags: [texture], canEdit: true });

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_info_remove_tag' }));
    expect(await screen.findByText('frameleaf_info_error_remove_tag')).toBeInTheDocument();
    expect(screen.getByText('texture')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_error_retry' }));
    await waitFor(() => expect(screen.queryByText('texture')).not.toBeInTheDocument());
    expect(sdkMock.untagAssets).toHaveBeenCalledTimes(2);
    expect(sdkMock.untagAssets).toHaveBeenLastCalledWith({ id: 't1', bulkIdsDto: { ids: ['asset'] } });
    expect(screen.queryByText('frameleaf_info_error_remove_tag')).not.toBeInTheDocument();
  });

  it('shows tags without edit controls to anyone but the owner', () => {
    render(BoardsTagEditor, { assetId: 'asset', tags: [texture], canEdit: false });
    expect(screen.getByText('texture')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
  });
});
