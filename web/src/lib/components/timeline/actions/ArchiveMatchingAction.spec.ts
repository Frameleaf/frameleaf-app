import { AssetVisibility } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ArchiveOperationsModal from '$lib/modals/ArchiveOperationsModal.svelte';
import ArchiveMatchingAction from './ArchiveMatchingAction.svelte';

const query = {
  scope: { kind: 'library' },
  filters: { visibility: AssetVisibility.Timeline, withStacked: true, withPartners: true },
};
beforeEach(() => vi.restoreAllMocks());
it('opens the production preparation flow with the live typed query instead of loaded asset IDs', async () => {
  const show = vi.spyOn(modalManager, 'show').mockResolvedValue(undefined as never);
  render(ArchiveMatchingAction, { query });
  await fireEvent.click(screen.getByRole('button'));
  expect(show).toHaveBeenCalledWith(ArchiveOperationsModal, {
    matchingQuery: expect.any(Function),
    currentMatchingQuery: expect.any(Function),
  });
  const props = show.mock.calls[0][1] as unknown as { matchingQuery: () => unknown };
  expect(props.matchingQuery()).toMatchObject(query);
});
it.each([
  { ...query, scope: { kind: 'map' } },
  { ...query, filters: { ...query.filters, assetFilter: new Set(['local-cluster']) } },
])('does not broaden unsupported query scopes', (unsupported) => {
  render(ArchiveMatchingAction, { query: unsupported });
  expect(screen.getByRole('button')).toBeDisabled();
});
