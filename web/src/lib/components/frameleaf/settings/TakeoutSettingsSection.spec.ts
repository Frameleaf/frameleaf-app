import { TakeoutPhase, TakeoutState, type TakeoutResponseDto } from '@frameleaf/sdk';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import TakeoutSettingsSection from '$lib/components/frameleaf/settings/TakeoutSettingsSection.svelte';
import en from '../../../../../../i18n/en.json';

/**
 * FL-83: Command Center → Backup & import → "Google Photos & server imports". As in the prototype,
 * "Preview import workflow" opens the "Import Google Photos" workflow in place, as a wide dialog;
 * the address says it is open (and on which import), so links and reloads land in it.
 */

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/user-settings?area=backup&section=takeout'),
  goto: vi.fn(),
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return state.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: state.goto }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', isAdmin: false }, params: {} },
}));

const at = (query: string) => (state.url = new URL(`http://localhost/user-settings?${query}`));

const takeout = (id: string, name: string) =>
  ({
    id,
    name,
    phase: TakeoutPhase.Sources,
    state: TakeoutState.Sources,
    action: null,
    albums: [],
    sources: [],
    options: { sidecarReview: true },
    counts: { imported: 0, matched: 0, items: 0, review: 0, ready: 0, failed: 0, importing: 0, hiddenLocked: 0 },
    updatedAt: '2026-09-20T10:00:00.000Z',
  }) as unknown as TakeoutResponseDto;

describe('TakeoutSettingsSection', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.resetAllMocks();
    at('area=backup&section=takeout');
    sdkMock.listTakeoutImports.mockResolvedValue([takeout('import-1', 'Family export')]);
  });

  it('opens the import workflow in place from its action', async () => {
    render(TakeoutSettingsSection);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sdkMock.listTakeoutImports).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: en.frameleaf_takeout_settings_action }));
    expect(state.goto).toHaveBeenCalledWith(
      '/user-settings?area=backup&section=takeout&workflow=import',
      expect.objectContaining({ noScroll: true }),
    );
  });

  it('shows the workflow dialog with the server’s imports when the address opens it', async () => {
    at('area=backup&section=takeout&workflow=import');
    render(TakeoutSettingsSection);
    const dialog = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    expect(await within(dialog).findByRole('link', { name: /Family export/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: en.frameleaf_takeout_start_heading })).toBeInTheDocument();
    expect(sdkMock.getTakeoutImport).not.toHaveBeenCalled();
  });

  it('opens one import from a deep link', async () => {
    sdkMock.getTakeoutImport.mockResolvedValue(takeout('import-1', 'Family export'));
    at('area=backup&section=takeout&workflow=import&import=import-1');
    render(TakeoutSettingsSection);
    const dialog = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    expect(
      await within(dialog).findByRole('heading', { name: en.frameleaf_takeout_stage_heading }),
    ).toBeInTheDocument();
    expect(sdkMock.getTakeoutImport).toHaveBeenCalledWith({ id: 'import-1' });
  });

  it('closes back to the section, keeping the rest of the address', async () => {
    at('area=backup&section=takeout&workflow=import&scope=all');
    render(TakeoutSettingsSection);
    const dialog = screen.getByRole('dialog', { name: en.frameleaf_takeout_title });
    await waitFor(() => expect(sdkMock.listTakeoutImports).toHaveBeenCalled());
    await userEvent.click(await within(dialog).findByRole('button', { name: en.frameleaf_takeout_cancel }));
    expect(state.goto).toHaveBeenCalledWith(
      '/user-settings?area=backup&section=takeout&scope=all',
      expect.objectContaining({ noScroll: true }),
    );
  });
});
