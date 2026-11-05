import type { PetResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import type { PageData } from './$types';
import PetPage from './+page.svelte';

const callbacks = vi.hoisted(() => ({
  decisions: undefined as { onChanged: () => void } | undefined,
  mounts: 0,
}));
vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$lib/components/frameleaf/LibraryView.svelte', async () => ({
  default: (await import('@test-data/frameleaf/LibraryViewStub.svelte')).default,
}));
vi.mock('$lib/components/frameleaf/pets/PetDecisions.svelte', () => ({
  default: (_anchor: unknown, props: NonNullable<typeof callbacks.decisions>) => {
    callbacks.decisions = props;
    callbacks.mounts++;
  },
}));
vi.mock('$lib/components/frameleaf/pets/PetThumbnail.svelte', () => ({ default: () => {} }));
vi.mock('$lib/components/timeline/TimelineAssetViewer.svelte', async () => ({
  default: (await import('@test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('$lib/frameleaf/filter-entity-names', () => ({ resolveEntityName: vi.fn().mockResolvedValue('Rex') }));

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

beforeAll(() => addMessages('dev', en));

it('shows the pet’s photos in the Library view, scoped to the pet on the timeline', () => {
  render(PetPage, { data: { pet, meta: { title: 'Rex' } } as unknown as PageData });

  expect(screen.getByRole('heading', { level: 1, name: 'Rex' })).toBeInTheDocument();
  expect(JSON.parse(screen.getByTestId('library-options').textContent!)).toEqual({
    visibility: 'timeline',
    petId: 'pet-1',
  });
  expect(screen.getByRole('link', { name: en.frameleaf_pet_photos_back })).toHaveAttribute('href', '/pets');
});

it('reads the photos again when a decision about the pet changes', async () => {
  render(PetPage, { data: { pet, meta: { title: 'Rex' } } as unknown as PageData });
  const before = callbacks.mounts;

  callbacks.decisions!.onChanged();

  await waitFor(() => expect(callbacks.mounts).toBe(before + 1));
});
