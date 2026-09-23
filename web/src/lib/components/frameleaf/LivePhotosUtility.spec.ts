import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { SvelteMap } from 'svelte/reactivity';
import en from '../../../../../i18n/en.json';
import LivePhotosUtility from './LivePhotosUtility.svelte';

const state = vi.hoisted(() => ({ run: vi.fn(), info: vi.fn(), tiles: new Map<string, { state: 'pending' }>() }));
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getAssetInfo: state.info,
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'owner', name: 'Alex' }, params: {} },
}));
vi.mock('$lib/frameleaf/bulk-controller.svelte', () => ({
  BulkController: class {
    busy = false;
    run = state.run;
  },
}));
vi.mock('$lib/frameleaf/durable-bulk-tracker.svelte', () => ({
  durableBulkTracker: { stateOf: (id: string) => state.tiles.get(id) },
}));

describe('Live Photo utility filters', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    state.tiles = new SvelteMap();
    state.run.mockReset().mockResolvedValue({ succeeded: ['one'], failed: [] });
    state.info.mockReset();
  });
  const confirmHighConfidence = async () => {
    await userEvent.click(screen.getByRole('button', { name: 'Link high-confidence pairs' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Confirm 1 pair' }));
  };
  it('keeps successful links in All results and prevents linking them again', async () => {
    render(LivePhotosUtility, { data: fixture() });
    await confirmHighConfidence();
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Lake.heic' })).not.toBeInTheDocument());
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'all');
    const photo = await screen.findByRole('img', { name: 'Lake.heic' });
    const linkedRow = within(photo.closest('article')!);
    expect(linkedRow.getByText('Linked')).toBeInTheDocument();
    expect(linkedRow.getByRole('button', { name: 'Review pair' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Link high-confidence pairs' })).toBeDisabled();
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'open');
    expect(screen.queryByRole('img', { name: 'Lake.heic' })).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Cabin.heic' })).toBeInTheDocument();
  });
  it.each([true, false])('reads the saved link after a durable marker clears (linked=%s)', async (linked) => {
    state.run.mockImplementation(async () => {
      state.tiles.set('one', { state: 'pending' });
      return null;
    });
    state.info.mockResolvedValue({ id: 'one', livePhotoVideoId: linked ? 'v1' : null });
    render(LivePhotosUtility, { data: fixture() });
    await confirmHighConfidence();
    await waitFor(() => expect(state.run).toHaveBeenCalledOnce());
    state.tiles.delete('one');
    await waitFor(() => expect(state.info).toHaveBeenCalledExactlyOnceWith({ id: 'one' }));
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Show' }), 'all');
    const row = within(screen.getByRole('img', { name: 'Lake.heic' }).closest('article')!);
    expect(Boolean(row.queryByText('Linked'))).toBe(linked);
    expect(row.getByRole('button', { name: 'Review pair' }).hasAttribute('disabled')).toBe(linked);
  });
  it('never offers a foreign owner pair for mutation', async () => {
    const data = fixture();
    data.candidates.candidates[0].photo.ownerId = 'other';
    render(LivePhotosUtility, { data });
    expect(screen.getByRole('button', { name: 'Link high-confidence pairs' })).toBeDisabled();
    const row = within(screen.getByRole('img', { name: 'Lake.heic' }).closest('article')!);
    expect(row.getByRole('button', { name: 'Review pair' })).toBeDisabled();
  });
  it('limits the high-confidence batch to the visible candidate set', async () => {
    const data = fixture();
    render(LivePhotosUtility, { data });
    const link = screen.getByRole('button', { name: 'Link high-confidence pairs' });
    expect(link).toBeEnabled();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Find items' }), 'Cabin');
    await waitFor(() => expect(link).toBeDisabled());
    expect(screen.queryByText('Lake.heic')).not.toBeInTheDocument();
    expect(screen.getByText('Cabin.heic')).toBeInTheDocument();
  });
});

const fixture = () =>
  ({
    tool: 'live-photos',
    candidates: {
      candidates: [
        {
          photo: { id: 'one', ownerId: 'owner', originalFileName: 'Lake.heic' },
          video: { id: 'v1', ownerId: 'owner', originalFileName: 'Lake.mov' },
          confidence: 'high',
          matchReason: 'Same identifier',
        },
        {
          photo: { id: 'two', ownerId: 'owner', originalFileName: 'Cabin.heic' },
          video: { id: 'v2', ownerId: 'owner', originalFileName: 'Cabin.mov' },
          confidence: 'low',
          matchReason: 'Similar capture time',
        },
      ],
    },
  }) as ComponentProps<typeof LivePhotosUtility>['data'];
