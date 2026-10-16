import { searchAssets, type AssetResponseDto, type PetResponseDto } from '@frameleaf/sdk';
import { render, waitFor } from '@testing-library/svelte';
import { deferredPromise } from '@test-data/deferred';
import { assetFactory } from '@test-data/factories/asset-factory';
import type { PageData } from './$types';
import PetPage from './+page.svelte';

const callbacks = vi.hoisted(() => ({
  results: undefined as { assets: { id: string }[]; onEndReached: () => void } | undefined,
  decisions: undefined as { onChanged: () => void } | undefined,
}));
vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$lib/components/frameleaf/ResultsView.svelte', () => ({
  default: (anchor: unknown, props: NonNullable<typeof callbacks.results> & { header?: (a: unknown) => void }) => {
    callbacks.results = props;
    props.header?.(anchor);
  },
}));
vi.mock('$lib/components/frameleaf/pets/PetDecisions.svelte', () => ({
  default: (_anchor: unknown, props: NonNullable<typeof callbacks.decisions>) => {
    callbacks.decisions = props;
  },
}));
vi.mock('$lib/components/frameleaf/pets/PetThumbnail.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/frameleaf/ResultsAssetViewer.svelte', () => ({ default: () => {} }));
vi.mock('$lib/frameleaf/filter-entity-names', () => ({ resolveEntityName: vi.fn().mockResolvedValue('Rex') }));
vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), searchAssets: vi.fn() }));

type SearchResult = Awaited<ReturnType<typeof searchAssets>>;
const page = (items: AssetResponseDto[], nextCursor: string | null) =>
  ({ assets: { items, nextCursor } }) as unknown as SearchResult;

const pet = {
  id: 'pet-1',
  name: 'Rex',
  species: 'dog',
  birthDate: null,
  featuredAssetId: null,
  updatedAt: '2026-01-01T00:00:00.000Z',
  assetCount: 3,
  isHidden: false,
} as unknown as PetResponseDto;

it('drops a page that was in flight when the photos reloaded', async () => {
  const [first, late, fresh] = [assetFactory.build(), assetFactory.build(), assetFactory.build()];
  const pending = deferredPromise<SearchResult>();
  vi.mocked(searchAssets)
    .mockResolvedValueOnce(page([first], 'c1'))
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce(page([first, fresh], null));

  render(PetPage, { data: { pet, meta: { title: 'Rex' } } as unknown as PageData });
  await waitFor(() => expect(callbacks.results?.assets.map(({ id }) => id)).toEqual([first.id]));

  callbacks.results!.onEndReached();
  callbacks.decisions!.onChanged();
  await waitFor(() => expect(callbacks.results?.assets.map(({ id }) => id)).toEqual([first.id, fresh.id]));

  pending.resolve(page([late], 'c2'));
  await pending.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(callbacks.results!.assets.map(({ id }) => id)).toEqual([first.id, fresh.id]);
});
