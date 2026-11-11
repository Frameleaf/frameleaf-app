import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CreatorItemPanel from './CreatorItemPanel.svelte';
import { creatorFixture, itemFixture } from './creators.fixture';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const mount = (item = itemFixture(), creator = creatorFixture()) => {
  const handlers = { onClose: vi.fn(), onChange: vi.fn(), onDeleted: vi.fn() };
  const view = render(CreatorItemPanel, { item, creator, ...handlers });
  return { ...handlers, ...view };
};

beforeEach(() => {
  addMessages('dev', en);
});

describe('CreatorItemPanel', () => {
  it('marks an item watched, then not watched', async () => {
    sdkMock.updateMediaWatch.mockResolvedValue({ assetId: 'asset-1', watched: true, position: 0, updatedAt: '' });
    const { onChange, rerender } = mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Mark watched' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ watched: true })));
    expect(sdkMock.updateMediaWatch).toHaveBeenLastCalledWith({
      assetId: 'asset-1',
      mediaWatchUpdateDto: { watched: true },
    });

    sdkMock.updateMediaWatch.mockResolvedValue({ assetId: 'asset-1', watched: false, position: 0, updatedAt: '' });
    await rerender({ item: itemFixture({ watched: true }) });
    await fireEvent.click(screen.getByRole('button', { name: 'Mark not watched' }));
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ watched: false })));
    expect(sdkMock.updateMediaWatch).toHaveBeenLastCalledWith({
      assetId: 'asset-1',
      mediaWatchUpdateDto: { watched: false },
    });
  });

  it('offers to carry on a video that was started', () => {
    mount(itemFixture({ position: 120 }));
    expect(screen.getByRole('button', { name: 'Carry on watching' })).toBeInTheDocument();
  });

  it('shows what a site wrote as text and links only to a web address', () => {
    const title = '<img src="x" onerror="window.evil()">';
    const description = '<script>window.evil()</script>Frame day.';
    const { container } = mount(
      itemFixture({ title, description, tags: ['<b>tag</b>'], pageUrl: 'javascript:alert(1)' }),
      creatorFixture({ name: '<i>Mara</i>', handle: '<u>@mara</u>' }),
    );
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.getByText(description)).toBeInTheDocument();
    expect(screen.getByText('#<b>tag</b>')).toBeInTheDocument();
    expect(screen.getByText('<i>Mara</i>')).toBeInTheDocument();
    expect(container.querySelector(':scope [onerror], :scope script, :scope dd :is(i, b, u)')).toBeNull();
    // An address that is not http(s) is never a link.
    expect(screen.queryByRole('link', { name: 'Open on YouTube' })).not.toBeInTheDocument();
    expect(screen.queryByText('Original')).not.toBeInTheDocument();
  });

  it('links to the original when it is a web address', () => {
    mount();
    const link = screen.getByRole('link', { name: 'Open on YouTube' });
    expect(link).toHaveAttribute('href', 'https://www.youtube.com/watch?v=loft3');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Your subscription')).toBeInTheDocument();
  });

  it('moves an item to the trash', async () => {
    sdkMock.deleteAssets.mockResolvedValue(undefined as never);
    const { onDeleted } = mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('asset-1'));
    expect(sdkMock.deleteAssets).toHaveBeenCalledWith({ assetBulkDeleteDto: { ids: ['asset-1'] } });
  });
});
