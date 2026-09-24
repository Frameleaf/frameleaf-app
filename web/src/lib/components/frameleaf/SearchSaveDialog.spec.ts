import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery, type DiscoveryQuery } from '$lib/components/discovery/query';
import SearchSaveDialog from './SearchSaveDialog.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const JAMIE = '00000000-0000-4000-8000-000000000001';
const ALBUM = '00000000-0000-4000-8000-000000000020';

const page = (ids: string[], nextCursor: string | null) => ({
  albums: { total: 0, count: 0, items: [], facets: [] },
  assets: { total: 3, count: ids.length, items: ids.map((id) => ({ id })), facets: [], nextPage: null, nextCursor },
});

describe('SearchSaveDialog', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(goto).mockResolvedValue();
  });

  const setup = (query: DiscoveryQuery, count?: number) => {
    const onSaved = vi.fn();
    render(SearchSaveDialog, { open: true, query, defaultName: 'Jamie', count, onSaved });
    return { onSaved };
  };

  it('creates a rule-backed smart album from a search a rule can say', async () => {
    sdkMock.createClassificationRule.mockResolvedValue({ albumId: ALBUM } as never);
    const query = {
      ...emptyDiscoveryQuery(),
      mode: 'smart' as const,
      text: 'hike',
      filter: { personIds: { all: [JAMIE] } },
    };
    const { onSaved } = setup(query);
    await fireEvent.click(screen.getByRole('button', { name: /Smart album/ }));
    await waitFor(() =>
      expect(sdkMock.createClassificationRule).toHaveBeenCalledWith({
        classificationRuleCreateDto: { albumName: 'Jamie', personIds: [JAMIE], visualQueries: ['hike'] },
      }),
    );
    expect(onSaved).toHaveBeenCalledWith('smart', true);
    expect(goto).toHaveBeenCalledWith(`/albums/${ALBUM}`);
  });

  it('disables the smart album for a search a rule cannot say, and says why', () => {
    setup({ ...emptyDiscoveryQuery(), filter: { city: { eq: 'Banff' } } });
    const smart = screen.getByRole('button', { name: /Smart album/ });
    expect(smart).toBeDisabled();
    expect(smart).toHaveTextContent('Only searches by people');
  });

  it('confirms the exact number, then snapshots every match into a new album and reports per item', async () => {
    sdkMock.searchAssets
      .mockResolvedValueOnce(page(['a1', 'a2'], 'next') as never)
      .mockResolvedValueOnce(page(['a3'], null) as never);
    sdkMock.createAlbum.mockResolvedValue({ id: ALBUM } as never);
    sdkMock.addAssetsToAlbum.mockResolvedValue([
      { id: 'a1', success: true },
      { id: 'a2', success: false, error: 'duplicate' },
      { id: 'a3', success: false, error: 'unknown' },
    ] as never);
    setup({ ...emptyDiscoveryQuery(), filter: { city: { eq: 'Banff' } } }, 3);
    expect(screen.getByRole('button', { name: /Album snapshot/ })).toHaveTextContent('3 current items');
    await fireEvent.click(screen.getByRole('button', { name: /Album snapshot/ }));
    expect(await screen.findByText('3 items will be saved in a new album.')).toBeInTheDocument();
    expect(sdkMock.createAlbum).not.toHaveBeenCalled();
    // The snapshot search keeps the timeline default, so Locked, archived and trashed items stay out
    const [{ metadataSearchDto }] = sdkMock.searchAssets.mock.calls[0];
    expect(metadataSearchDto.filter).toMatchObject({ city: { eq: 'Banff' }, visibility: { eq: 'timeline' } });
    expect(sdkMock.searchAssets.mock.calls[1][0].metadataSearchDto.cursor).toBe('next');

    await fireEvent.click(screen.getByRole('button', { name: 'Create album' }));
    expect(await screen.findByText(/1 item added\./)).toHaveTextContent(/1 skipped.*1 couldn't be added/);
    expect(sdkMock.createAlbum).toHaveBeenCalledWith({ createAlbumDto: { albumName: 'Jamie' } });
    expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledWith({ id: ALBUM, bulkIdsDto: { ids: ['a1', 'a2', 'a3'] } });
    await fireEvent.click(screen.getByRole('button', { name: 'Open album' }));
    expect(goto).toHaveBeenCalledWith(`/albums/${ALBUM}`);
  });

  it('says when only the first matches or the top ranked matches will be saved', async () => {
    sdkMock.searchSmart.mockResolvedValue(
      page(
        Array.from({ length: 250 }, (_, index) => `s${index}`),
        null,
      ) as never,
    );
    setup({ ...emptyDiscoveryQuery(), mode: 'smart', text: 'sunset' }, null as never);
    await fireEvent.click(screen.getByRole('button', { name: /Album snapshot/ }));
    expect(
      await screen.findByText(
        'Smart search ranks its matches; the top 250 ranked matches will be saved in a new album.',
      ),
    ).toBeInTheDocument();
  });

  it('does not create an album when nothing matches', async () => {
    setup({ ...emptyDiscoveryQuery(), filter: { city: { eq: 'Nowhere' } } }, 0);
    expect(screen.getByRole('button', { name: /Album snapshot/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Album snapshot/ })).toHaveTextContent('Nothing matches now');
  });

  it('offers Retry for the rest, or deleting the half-filled album, when adding fails', async () => {
    const ids = Array.from({ length: 600 }, (_, index) => `a${index}`);
    sdkMock.searchAssets.mockResolvedValue(page(ids, null) as never);
    sdkMock.createAlbum.mockResolvedValue({ id: ALBUM } as never);
    const ok = (chunk: string[]) => chunk.map((id) => ({ id, success: true }));
    sdkMock.addAssetsToAlbum
      .mockResolvedValueOnce(ok(ids.slice(0, 500)) as never)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ok(ids.slice(500)) as never);
    setup({ ...emptyDiscoveryQuery(), filter: { city: { eq: 'Banff' } } }, 600);
    await fireEvent.click(screen.getByRole('button', { name: /Album snapshot/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Create album' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('adding stopped after 500 of 600 items');
    expect(screen.getByRole('button', { name: 'Delete album' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('600 items added.')).toBeInTheDocument();
    expect(sdkMock.addAssetsToAlbum).toHaveBeenLastCalledWith({ id: ALBUM, bulkIdsDto: { ids: ids.slice(500) } });
  });

  it('deletes the half-filled album when asked', async () => {
    sdkMock.searchAssets.mockResolvedValue(page(['a1'], null) as never);
    sdkMock.createAlbum.mockResolvedValue({ id: ALBUM } as never);
    sdkMock.addAssetsToAlbum.mockRejectedValue(new Error('offline'));
    sdkMock.deleteAlbum.mockResolvedValue(undefined as never);
    setup({ ...emptyDiscoveryQuery(), filter: { city: { eq: 'Banff' } } }, 1);
    await fireEvent.click(screen.getByRole('button', { name: /Album snapshot/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Create album' }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Delete album' }));
    await waitFor(() => expect(sdkMock.deleteAlbum).toHaveBeenCalledWith({ id: ALBUM }));
    expect(await screen.findByText('The partly filled album was deleted.')).toBeInTheDocument();
  });

  it('notes that a smart-text smart album follows its threshold, not the ranking', () => {
    setup({ ...emptyDiscoveryQuery(), mode: 'smart', text: 'sunset' });
    expect(screen.getByRole('button', { name: /Smart album/ })).toHaveTextContent("rule's threshold");
  });
});
