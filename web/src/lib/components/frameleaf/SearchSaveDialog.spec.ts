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

  it('snapshots every matching item into a new album, page by page', async () => {
    sdkMock.searchAssets
      .mockResolvedValueOnce(page(['a1', 'a2'], 'next') as never)
      .mockResolvedValueOnce(page(['a3'], null) as never);
    sdkMock.createAlbum.mockResolvedValue({ id: ALBUM } as never);
    sdkMock.addAssetsToAlbum.mockResolvedValue([] as never);
    setup({ ...emptyDiscoveryQuery(), filter: { city: { eq: 'Banff' } } }, 3);
    expect(screen.getByRole('button', { name: /Album snapshot/ })).toHaveTextContent('3 current items');
    await fireEvent.click(screen.getByRole('button', { name: /Album snapshot/ }));
    await waitFor(() =>
      expect(sdkMock.addAssetsToAlbum).toHaveBeenCalledWith({ id: ALBUM, bulkIdsDto: { ids: ['a1', 'a2', 'a3'] } }),
    );
    expect(sdkMock.createAlbum).toHaveBeenCalledWith({ createAlbumDto: { albumName: 'Jamie' } });
    // The snapshot search keeps the timeline default, so Locked, archived and trashed items stay out
    const [{ metadataSearchDto }] = sdkMock.searchAssets.mock.calls[0];
    expect(metadataSearchDto.filter).toMatchObject({ city: { eq: 'Banff' }, visibility: { eq: 'timeline' } });
    expect(sdkMock.searchAssets.mock.calls[1][0].metadataSearchDto.cursor).toBe('next');
  });
});
