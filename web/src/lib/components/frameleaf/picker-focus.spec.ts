import { render, screen, waitFor } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import AlbumMergeIntoDialog from '$lib/components/frameleaf/AlbumMergeIntoDialog.svelte';
import AlbumMoveDialog from '$lib/components/frameleaf/AlbumMoveDialog.svelte';
import AddRelationshipDialog from '$lib/components/frameleaf/people/AddRelationshipDialog.svelte';
import PersonPicker from '$lib/components/frameleaf/people/PersonPicker.svelte';
import { albumFactory } from '@test-data/factories/album-factory';
import { personFactory } from '@test-data/factories/person-factory';

/** FL-1823: a picker opens with the cursor in its search field. */
describe('pickers focus their search field on open', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sdkMock.getAllPeople.mockResolvedValue({ people: [], hasNextPage: false, total: 0, hidden: 0 });
  });

  const albums = [albumFactory.build({ albumName: 'Trips' }), albumFactory.build({ albumName: 'Family' })];

  it('Move album', async () => {
    render(AlbumMoveDialog, { moving: [albums[0]], albums, open: true, onMove: vi.fn() });
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
  });

  it('Merge albums into', async () => {
    render(AlbumMergeIntoDialog, { merging: albums, albums, open: true, onMerge: vi.fn() });
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
  });

  it('Add relationship', async () => {
    render(AddRelationshipDialog, { person: personFactory.build(), onAdded: vi.fn(), onClosed: vi.fn() });
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
  });

  it('Person picker (fix a match, "Someone else")', async () => {
    render(PersonPicker, { excludeId: 'person-1', label: 'Move to', onPick: vi.fn() });
    await waitFor(() => expect(screen.getByRole('searchbox')).toHaveFocus());
  });
});
