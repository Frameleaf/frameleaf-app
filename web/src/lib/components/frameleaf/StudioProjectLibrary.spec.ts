import { StudioProjectAccess, StudioProjectShelf, type StudioProjectDto } from '@frameleaf/sdk';
import { render, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import StudioProjectLibrary from './StudioProjectLibrary.svelte';

const project = (thumbnailAssetId: string | null): StudioProjectDto => ({
  id: 'p-1',
  ownerId: 'me',
  name: 'Lake trip',
  spaceId: null,
  revision: 2,
  access: StudioProjectAccess.Owner,
  lease: {
    heldByYou: false,
    heldByAnother: false,
    expiresAt: null,
    leaseMs: 90_000,
    renewMs: 30_000,
    autosaveDebounceMs: 1500,
  },
  shelf: StudioProjectShelf.Active,
  archivedAt: null,
  deletedAt: null,
  purgeAfter: null,
  lastOpenedAt: null,
  thumbnailAssetId,
  duplicatedFromId: null,
  importedFromBundle: false,
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
});

/** FL-195 follow-up: a Locked poster keeps its place but shows only to the unlocked session. */
describe('StudioProjectLibrary poster', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    sdkMock.searchStudioProjects.mockReset();
  });

  it('shows the placeholder while the server withholds the poster, and the poster after an unlock', async () => {
    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    const { container } = render(StudioProjectLibrary);

    await waitFor(() => expect(container.querySelector(':scope .card')).not.toBeNull());
    expect(container.querySelector(':scope .poster img')).toBeNull();

    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project('poster-asset')], total: 1 });
    eventManager.emit('SessionAccessChanged', { isElevated: true });

    await waitFor(() => expect(container.querySelector(':scope .poster img')).not.toBeNull());
    expect(sdkMock.searchStudioProjects).toHaveBeenCalledTimes(4);

    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    eventManager.emit('SessionAccessChanged', { isElevated: false });

    await waitFor(() => expect(container.querySelector(':scope .poster img')).toBeNull());
  });
});
