import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import { SvelteURL } from 'svelte/reactivity';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import UtilitiesArea from '$lib/components/frameleaf/settings/UtilitiesArea.svelte';
import en from '../../../../../../i18n/en.json';

const state = vi.hoisted(() => ({
  url: new URL('http://localhost/user-settings?area=utilities'),
  user: { id: 'me', isAdmin: false },
  load: vi.fn(),
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
  authManager: {
    get user() {
      return state.user;
    },
    params: {},
  },
}));
vi.mock('$lib/frameleaf/utilities-load', () => ({ loadUtility: state.load }));

describe('Utilities area', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    state.url = new SvelteURL('http://localhost/user-settings?area=utilities');
    state.user = { id: 'me', isAdmin: false };
    state.load.mockReset().mockReturnValue(new Promise(() => {}));
    state.goto.mockReset();
  });
  it('renders prototype grouped cards without loading a tool', async () => {
    render(UtilitiesArea);
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeInTheDocument();
    for (const name of ['Organize', 'Repair', 'Import', 'Automate', 'Connect']) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: /Missing files/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mobile apps/ })).toBeInTheDocument();
    expect(state.load).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /Duplicate review/ }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=utilities&section=duplicates', expect.any(Object));
  });
  it('opens on what needs a look, with those tools first, and offers no Android direct updates (FL-519, FL-1116)', async () => {
    state.user = { id: 'me', isAdmin: true };
    sdkMock.getUtilitiesSummary.mockResolvedValue({
      duplicateGroups: 12,
      withoutPlace: 214,
      missingFiles: 3,
      damagedFiles: 0,
      unusedFiles: 86,
      unusedBytes: 410_000_000,
    });
    render(UtilitiesArea);

    expect(await screen.findByRole('heading', { name: '2 tools have something for you' })).toBeInTheDocument();
    // The first group is the "Needs a look" card (a kit Section, named by its heading).
    const first = screen.getByRole('region', { name: 'Needs a look' });
    expect(first.previousElementSibling).toHaveAttribute('aria-label', 'Tools');
    expect(first).toHaveTextContent('Duplicate review');
    expect(first).toHaveTextContent('12 groups to look at');
    expect(first).toHaveTextContent('3 files missing');
    const fixLocations = screen.getByRole('button', { name: /Fix locations/ }).closest('li') as HTMLElement;
    expect(fixLocations).toHaveTextContent('214 photos have no place');
    expect(screen.queryByText(/Android direct updates/)).toBeNull();
  });

  it('says each other tool’s state and "Checked last night" (FL-539)', async () => {
    state.user = { id: 'me', isAdmin: true };
    sdkMock.getUtilitiesSummary.mockResolvedValue({
      duplicateGroups: 12,
      withoutPlace: 0,
      missingFiles: 0,
      damagedFiles: 0,
      unusedFiles: 0,
      unusedBytes: 0,
    });
    sdkMock.searchLargeAssets.mockResolvedValue([{ exifInfo: { fileSizeInByte: 4_200_000_000 } }] as never);
    sdkMock.getLivePhotoCandidates.mockResolvedValue({ candidates: [], total: 2, suggestionsEnabled: true });
    sdkMock.listICloudConnections.mockResolvedValue({ enabled: true, connections: [] } as never);
    sdkMock.searchWorkflows.mockResolvedValue([{}, {}] as never);
    sdkMock.listBackupDevices.mockResolvedValue({ devices: [{}, {}, {}], nextOffset: null } as never);
    sdkMock.getOvernight.mockResolvedValue({ nights: [{ finishedAt: new Date().toISOString() }] } as never);
    render(UtilitiesArea);

    expect(await screen.findByText('2 to pair')).toBeInTheDocument();
    expect(await screen.findByText(/The largest is/)).toBeInTheDocument();
    expect(screen.getByText('3 phones connected')).toBeInTheDocument();
    expect(screen.getByText('2 rules')).toBeInTheDocument();
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.getAllByText('Checked last night').length).toBeGreaterThan(0);
    // As the prototype: a checked tool with nothing waiting is green; a waiting one amber; a fact neutral.
    const toneOf = (text: string) => screen.getByText(text).closest<HTMLElement>('[data-tone]')?.dataset.tone;
    expect(toneOf('2 to pair')).toBe('warn');
    expect(toneOf('12 groups to look at')).toBe('warn');
    expect(toneOf('No damage found')).toBe('good');
    expect(toneOf('Nothing missing')).toBe('good');
    expect(toneOf('2 rules')).toBe('off');
  });

  it('says nothing needs a look when every tool is calm (FL-519)', async () => {
    sdkMock.getLivePhotoCandidates.mockResolvedValue({ candidates: [], total: 0, suggestionsEnabled: true });
    sdkMock.getUtilitiesSummary.mockResolvedValue({
      duplicateGroups: 0,
      withoutPlace: 0,
      missingFiles: null,
      damagedFiles: null,
      unusedFiles: null,
      unusedBytes: null,
    });
    render(UtilitiesArea);

    expect(await screen.findByRole('heading', { name: 'Nothing needs a look' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Needs a look' })).toBeNull();
  });

  it('shows each tool’s icon in the directory (UT-12)', () => {
    render(UtilitiesArea);
    for (const name of [/Duplicate review/, /Large files/, /Mobile apps/]) {
      const row = screen.getByRole('button', { name }).closest('li') as HTMLElement;
      // The tool's icon comes first, before the title; the "Open ›" button carries the chevron.
      expect(row.firstElementChild?.querySelector('svg')).not.toBeNull();
      expect(screen.getByRole('button', { name }).querySelector('svg')).not.toBeNull();
    }
  });
  it('keeps an admin on the single utilities host', async () => {
    state.user.isAdmin = true;
    render(UtilitiesArea);
    await userEvent.click(screen.getByRole('button', { name: /Missing files/ }));
    expect(state.goto).toHaveBeenCalledWith('/user-settings?area=utilities&section=missing-media', expect.any(Object));
  });
  it('rejects a direct non-admin health tool selection without loading it', () => {
    state.url.searchParams.set('section', 'corrupt-media');
    render(UtilitiesArea);
    expect(screen.getByRole('alert')).toHaveTextContent('Administrator access');
    expect(state.load).not.toHaveBeenCalled();
  });
  it('shows the selected tool breadcrumb while loading and an actionable failure', async () => {
    state.url.searchParams.set('section', 'duplicates');
    state.load.mockRejectedValue(new Error('offline'));
    render(UtilitiesArea);
    expect(screen.getByRole('button', { name: 'Tools' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('This tool could not be loaded'));
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(state.load).toHaveBeenCalledTimes(2));
  });
  it('does not reload the tool when the photo viewer query changes', async () => {
    state.url.searchParams.set('section', 'duplicates');
    render(UtilitiesArea);
    await waitFor(() => expect(state.load).toHaveBeenCalledTimes(1));
    state.url.searchParams.set('assetId', 'photo');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.load).toHaveBeenCalledTimes(1);
  });
});
