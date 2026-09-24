import { SharedLinkType } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { handleCreateSharedLink } from '$lib/services/shared-link.service';
import en from '../../../../../i18n/en.json';
import SelectionBar from './SelectionBar.svelte';

vi.mock('$lib/services/shared-link.service', () => ({
  asUrl: () => 'https://frameleaf.local/s/test',
  handleCreateSharedLink: vi.fn().mockResolvedValue(true),
  handleUpdateSharedLink: vi.fn(),
}));

it('shares every explicitly selected ID after part of the selection leaves the loaded window', async () => {
  addMessages('dev', en);
  render(SelectionBar, {
    props: {
      count: 2,
      assets: [{ id: 'loaded', ownerId: 'me' }],
      selectedIds: ['loaded', 'offscreen'],
      context: { currentUserId: 'me' },
      onAction: vi.fn(),
      onClear: vi.fn(),
    },
  });

  await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_bulk_create_shared_link }));
  await fireEvent.click(screen.getByRole('button', { name: en.create_link }));

  expect(handleCreateSharedLink).toHaveBeenCalledWith(
    expect.objectContaining({ type: SharedLinkType.Individual, assetIds: ['loaded', 'offscreen'] }),
  );
});
