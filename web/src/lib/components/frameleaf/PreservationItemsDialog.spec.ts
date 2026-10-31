import { getPreservationPackageItems, type PreservationPackageDto } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import PreservationItemsDialog from './PreservationItemsDialog.svelte';

vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));
vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  getPreservationPackageItems: vi.fn(),
}));

it('uses an item identifier for unnamed ordinary failures and preserves the Locked fallback', async () => {
  addMessages('dev', en);
  vi.mocked(getPreservationPackageItems).mockResolvedValue({
    items: [
      {
        id: 'failed',
        sourceAssetId: 'original-1',
        name: null,
        locked: false,
        state: 'failed',
        reasonKey: 'checksum_mismatch',
      },
      { id: 'locked', sourceAssetId: 'private-identifier', name: null, locked: true, state: 'failed' },
      { id: 'copied', sourceAssetId: 'original-2', name: 'lake.jpg', locked: false, state: 'copied' },
    ],
    total: 3,
  } as never);
  render(PreservationItemsDialog, {
    props: { open: true, item: { id: 'package', name: 'Archive' } as PreservationPackageDto },
  });
  expect(await screen.findByText('original-1')).toBeInTheDocument();
  expect(screen.getByText(en.frameleaf_preservation_items_locked_name)).toBeInTheDocument();
  expect(screen.getByText('lake.jpg')).toBeInTheDocument();
  expect(screen.queryByText('private-identifier')).not.toBeInTheDocument();
});
