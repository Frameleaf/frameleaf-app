import type { TagResponseDto } from '@frameleaf/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { renderWithTooltips } from '$tests/helpers';
import BulkTagDialog from './BulkTagDialog.svelte';

const tag = (id: string, value: string) => ({ id, name: value, value }) as TagResponseDto;

describe('BulkTagDialog (FL-648)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView ??= () => {};
    vi.stubGlobal('visualViewport', null);
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  const search = (value: string) =>
    fireEvent.input(screen.getByRole('combobox', { name: 'frameleaf_bulk_tag_add' }), { target: { value } });

  it('offers the account’s existing tags when the view passes none', async () => {
    sdkMock.getAllTags.mockResolvedValue([tag('t-beach', 'beach'), tag('t-dog', 'dog')]);
    const onSubmit = vi.fn();
    renderWithTooltips(BulkTagDialog, { count: 4, onSubmit });

    await waitFor(() => expect(sdkMock.getAllTags).toHaveBeenCalledOnce());
    // the existing name is offered as the tag itself, not as "Create tag"
    await search('beach');

    const option = await screen.findByRole('option', { name: 'beach' });
    expect(screen.queryByText('frameleaf_bulk_tag_create')).not.toBeInTheDocument();
    await fireEvent.click(option);
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_bulk_tag_apply' }));
    expect(onSubmit).toHaveBeenCalledWith({ tagIds: ['t-beach'], newTagNames: [] });
  });

  it('uses the tags the view passes without loading them again', async () => {
    renderWithTooltips(BulkTagDialog, { count: 1, options: [{ id: 't-cake', name: 'cake' }], onSubmit: vi.fn() });

    await search('ca');

    expect(await screen.findByRole('option', { name: 'cake' })).toBeInTheDocument();
    expect(sdkMock.getAllTags).not.toHaveBeenCalled();
  });

  it('offers no "Create tag" while the tags are loading', async () => {
    let resolveTags!: (tags: TagResponseDto[]) => void;
    sdkMock.getAllTags.mockReturnValue(new Promise((resolve) => (resolveTags = resolve)));
    renderWithTooltips(BulkTagDialog, { count: 1, onSubmit: vi.fn() });

    await search('BEACH');
    expect(screen.queryByText('frameleaf_bulk_tag_create')).not.toBeInTheDocument();

    resolveTags([tag('t-beach', 'beach')]);
    expect(await screen.findByRole('option', { name: 'beach' })).toBeInTheDocument();
    expect(screen.queryByText('frameleaf_bulk_tag_create')).not.toBeInTheDocument();
  });

  it('keeps an exact match within the eight suggestions', async () => {
    const options = [
      ...Array.from({ length: 8 }, (_, index) => ({ id: `t-${index}`, name: `beach ${index}` })),
      { id: 't-beach', name: 'beach' },
    ];
    renderWithTooltips(BulkTagDialog, { count: 1, options, onSubmit: vi.fn() });

    await search('beach');

    const names = (await screen.findAllByRole('option')).map((option) => option.textContent?.trim());
    expect(names).toHaveLength(8);
    expect(names[0]).toBe('beach');
  });

  it('still creates a tag by name when the tags cannot be loaded', async () => {
    sdkMock.getAllTags.mockRejectedValue(new Error('offline'));
    const onSubmit = vi.fn();
    renderWithTooltips(BulkTagDialog, { count: 2, onSubmit });

    await waitFor(() => expect(sdkMock.getAllTags).toHaveBeenCalledOnce());
    await search('trip');
    await fireEvent.click(await screen.findByRole('option', { name: /trip/ }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_bulk_tag_apply' }));
    expect(onSubmit).toHaveBeenCalledWith({ tagIds: [], newTagNames: ['trip'] });
  });
});
