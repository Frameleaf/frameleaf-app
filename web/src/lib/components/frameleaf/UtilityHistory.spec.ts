import { MediaOperationKind, MediaOperationStatus } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import UtilityHistory from './UtilityHistory.svelte';

const state = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  searchMediaOperations: state.search,
}));

const operation = (id: string, kind: MediaOperationKind, label: string) => ({
  id,
  kind,
  label,
  status: MediaOperationStatus.Completed,
  destination: 'local',
  progress: 100,
  processedUnits: 1,
  totalUnits: 1,
  autoRetries: 0,
  settings: {},
  createdAt: '2026-09-23T10:00:00.000Z',
  startedAt: '2026-09-23T10:00:00.000Z',
});

describe('Recent utility activity (FL-69, UT-11)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    state.search.mockReset();
  });

  it('lists the viewer’s recent utility jobs under a closed disclosure', async () => {
    state.search.mockResolvedValue({
      items: [
        operation('a', MediaOperationKind.IcloudSync, 'Sync family album'),
        operation('b', MediaOperationKind.StudioExport, 'Render trailer'),
      ],
      total: 2,
    });
    render(UtilityHistory);

    const summary = await screen.findByText('Recent utility activity');
    await userEvent.click(summary);
    expect(screen.getByText(/Sync family album/)).toBeInTheDocument();
    expect(screen.queryByText(/Render trailer/)).not.toBeInTheDocument();
    expect(state.search).toHaveBeenCalledWith({ take: 50, includeDismissed: true });
  });

  it('shows nothing when there is no history or it cannot be read', async () => {
    state.search.mockRejectedValue(new Error('offline'));
    render(UtilityHistory);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Recent utility activity')).not.toBeInTheDocument();
  });
});
