import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'svelte';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import LivePhotosUtility from './LivePhotosUtility.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'owner', name: 'Alex' } } }));
vi.mock('$lib/frameleaf/bulk-controller.svelte', () => ({
  BulkController: class {
    busy = false;
  },
}));
vi.mock('$lib/frameleaf/durable-bulk-tracker.svelte', () => ({ durableBulkTracker: { stateOf: () => undefined } }));

describe('Live Photo utility filters', () => {
  beforeAll(() => addMessages('dev', en));
  it('limits the high-confidence batch to the visible candidate set', async () => {
    const data = {
      tool: 'live-photos',
      candidates: {
        candidates: [
          {
            photo: { id: 'one', ownerId: 'owner', originalFileName: 'Lake.heic' },
            video: { id: 'v1', originalFileName: 'Lake.mov' },
            confidence: 'high',
            matchReason: 'Same identifier',
          },
          {
            photo: { id: 'two', ownerId: 'owner', originalFileName: 'Cabin.heic' },
            video: { id: 'v2', originalFileName: 'Cabin.mov' },
            confidence: 'low',
            matchReason: 'Similar capture time',
          },
        ],
      },
    } as ComponentProps<typeof LivePhotosUtility>['data'];
    render(LivePhotosUtility, { data });
    const link = screen.getByRole('button', { name: 'Link high-confidence pairs' });
    expect(link).toBeEnabled();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find items' }), 'Cabin');
    await waitFor(() => expect(link).toBeDisabled());
    expect(screen.queryByText('Lake.heic')).not.toBeInTheDocument();
    expect(screen.getByText('Cabin.heic')).toBeInTheDocument();
  });
});
